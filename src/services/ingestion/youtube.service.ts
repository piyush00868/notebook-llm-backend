import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";
import { getAccessToken } from "../youtube-oauth.service";

const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * The submitted value is not a YouTube video link.
 *
 * A user error rather than a server fault, and one worth naming precisely:
 * `new URL` throws on a malformed value, which would otherwise surface as an
 * unreadable 500 from deep inside this file.
 */
export class InvalidYoutubeUrlError extends Error {
  constructor() {
    super("That does not look like a YouTube video link.");
    this.name = "InvalidYoutubeUrlError";
  }
}

function extractYoutubeVideoId(url: string) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidYoutubeUrlError();
  }

  const hostname = parsed.hostname.replace(/^www\./, "");

  if (hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }

  if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    return parsed.searchParams.get("v");
  }

  throw new InvalidYoutubeUrlError();
}

/**
 * Turns SRT into plain text.
 *
 * Cue indices and timestamps are discarded; only spoken lines are kept. Cues
 * are separated by a blank line, and a cue's own text can contain blank lines,
 * so anything that is not an index or a timestamp is treated as speech.
 */
export function parseSrt(srt: string): string {
  return srt
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((cue) =>
      cue
        .split("\n")
        .slice(2)
        .join(" "),
    )
    .map((text) => text.replace(/<[^>]+>/g, "").trim())
    .filter((text) => text.length > 0)
    .join(" ");
}

async function readGoogleReason(response: Response): Promise<string | null> {
  try {
    const cloned = response.clone();
    const body = (await cloned.json()) as {
      error?: { errors?: { reason?: string }[] };
    };

    return body.error?.errors?.[0]?.reason ?? null;
  } catch {
    return null;
  }
}

/**
 * Turns a Google API failure into a typed error.
 *
 * The body is logged because the status alone is ambiguous -- 403 covers a
 * missing scope, an API-key restriction, and Google's rule that
 * `captions.download` only serves videos the authenticated principal may read.
 */
async function transcriptApiError(
  response: Response,
  videoId: string,
): Promise<Error> {
  const reason = await readGoogleReason(response);
  const detail = (await response.text()).slice(0, 300);

  console.error(
    `YOUTUBE API ${response.status}${reason ? ` (${reason})` : ""} ` +
      `for ${videoId}: ${detail}`,
  );

  if (response.status === 404) {
    return new YoutubeTranscriptVideoUnavailableError(videoId);
  }

  if (response.status === 429 || reason === "quotaExceeded") {
    return new YoutubeTranscriptTooManyRequestError();
  }

  return new YoutubeTranscriptNotAvailableError(videoId);
}

/**
 * Reads captions through the official Data API using the user's OAuth token.
 *
 * Only the bearer token is sent: supplying an API key alongside it asks Google
 * to authenticate twice, which the YouTube Data API rejects.
 */
async function fetchViaOAuth(
  videoId: string,
  accessToken: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  const listResponse = await fetch(
    `${API_BASE}/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`,
    { headers },
  );

  if (!listResponse.ok) {
    throw await transcriptApiError(listResponse, videoId);
  }

  const listed = (await listResponse.json()) as {
    items?: { id: string; snippet?: { trackKind?: string } }[];
  };

  const tracks = listed.items ?? [];

  if (tracks.length === 0) {
    throw new YoutubeTranscriptDisabledError(videoId);
  }

  // Prefer a human-written track over an auto-generated one.
  const track =
    tracks.find((entry) => entry.snippet?.trackKind !== "asr") ?? tracks[0]!;

  const downloadResponse = await fetch(
    `${API_BASE}/captions/${encodeURIComponent(track.id)}?tfmt=srt`,
    { headers },
  );

  if (!downloadResponse.ok) {
    throw await transcriptApiError(downloadResponse, videoId);
  }

  const content = parseSrt(await downloadResponse.text());

  if (!content.trim()) {
    throw new YoutubeTranscriptDisabledError(videoId);
  }

  return content;
}

/**
 * The library's own User-Agent is a 2020 Chrome build and it sends no
 * cookies at all. Both are things a real browser would not do, and both are
 * the sort of detail a bot check weighs, so they are corrected here.
 */
const MODERN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * A `fetch` shaped like a browser's, for the library to make its calls with.
 *
 * `youtube-transcript` accepts this through `config.fetch`, which is the only
 * lever it exposes over how requests look on the wire.
 *
 * The User-Agent is only set when the library did not set one itself: it
 * deliberately sends an Android User-Agent for its InnerTube call, and
 * overwriting that would break the client context that call depends on.
 */
function browserLikeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);

  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", MODERN_USER_AGENT);
  }

  headers.set("Accept-Language", "en-US,en;q=0.9");

  // Recorded consent. Absent this, YouTube answers datacentre visitors with an
  // interstitial before any transcript request is considered.
  headers.set("Cookie", "CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI");

  return fetch(input, { ...init, headers });
}

/**
 * InnerTube is YouTube's own player endpoint: no consent page, no watch-page
 * HTML, and no User-Agent pretending to be a desktop browser. It is reached by
 * identifying as an official client, which is why the client version and
 * matching headers below have to travel together.
 */
const INNERTUBE_URL =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

interface InnerTubeClient {
  name: string;
  /** The numeric client id, which the `X-YouTube-Client-Name` header requires. */
  id: string;
  version: string;
  userAgent: string;
  extra: Record<string, unknown>;
}

/**
 * Clients to try, in order.
 *
 * They are not interchangeable from the outside: YouTube decides per client how
 * much trust a request has earned, and that judgement includes the caller's IP.
 * One client being served a login wall says nothing about the next, so a
 * refusal is a reason to try the following one rather than to give up.
 *
 * The mobile clients are listed because they are the ones that serve captions
 * without a proof-of-origin token. Desktop and embedded contexts were tested
 * and return no tracks for public videos at all, so they are not listed.
 */
const INNER_TUBE_CLIENTS: InnerTubeClient[] = [
  {
    name: "ANDROID",
    id: "3",
    version: "20.10.38",
    userAgent:
      "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    extra: { androidSdkVersion: 34 },
  },
  {
    name: "IOS",
    id: "5",
    version: "20.10.4",
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)",
    extra: { deviceModel: "iPhone16,2" },
  },
];

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    );
}

/**
 * Flattens a `timedtext` XML document into readable prose.
 *
 * Timings and styling are dropped. Each cue holds one `<s>` per spoken word, so
 * words are concatenated in order; cues carrying only whitespace -- the
 * paragraph breaks YouTube interleaves -- contribute nothing. Both the modern
 * `<p t d><s>` shape and the older `<text start dur>` one are accepted, since
 * which one comes back depends on the track rather than on the request.
 */
export function parseTimedTextXml(xml: string): string {
  const cues: string[] = [];
  const cuePattern = /<(?:p|text)\b[^>]*>([\s\S]*?)<\/(?:p|text)>/g;
  let cue: RegExpExecArray | null;

  while ((cue = cuePattern.exec(xml)) !== null) {
    const inner = cue[1]!;
    let text = "";
    const wordPattern = /<s\b[^>]*>([^<]*)<\/s>/g;
    let word: RegExpExecArray | null;

    while ((word = wordPattern.exec(inner)) !== null) {
      text += word[1]!;
    }

    if (!text) {
      text = inner.replace(/<[^>]+>/g, "");
    }

    text = decodeEntities(text).trim();

    if (text) {
      cues.push(text);
    }
  }

  return cues.join(" ");
}

/**
 * Reads captions through InnerTube, then fetches the chosen track's XML.
 *
 * The library does this too, but sends a bare client context and then discards
 * every failure behind a bare `catch`. Doing it here means a video with no
 * usable captions says why -- a blocked request and a genuinely caption-less
 * video look identical otherwise.
 */
async function fetchViaInnerTube(videoId: string): Promise<string> {
  const notes: string[] = [];
  let declined = false;

  /*
   * No Authorization header, deliberately.
   *
   * InnerTube does not accept the YouTube Data API token -- it authenticates
   * its own callers and rejects an unexpected bearer outright. Sending one
   * turned a 200 carrying a playability status into a bare 400, which reads as
   * "we sent something wrong" and hides the real answer. Anonymous at least
   * gets told plainly that it is being treated as a bot.
   */

  for (const client of INNER_TUBE_CLIENTS) {
    const response = await fetch(INNERTUBE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        "X-YouTube-Client-Name": client.id,
        "X-YouTube-Client-Version": client.version,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            hl: "en",
            gl: "US",
            ...client.extra,
          },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });

    if (!response.ok) {
      notes.push(`${client.name} HTTP ${response.status}`);
      continue;
    }

    const data = (await response.json()) as {
      playabilityStatus?: { status?: string; reason?: string };
      captions?: {
        playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
      };
    };

    const playability = data.playabilityStatus?.status;
    const reason = data.playabilityStatus?.reason ?? "";
    const tracks =
      data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    notes.push(
      `${client.name} ${playability ?? "unknown"}` +
        `${reason ? ` (${reason})` : ""} ${tracks.length} track(s)`,
    );

    /*
     * YouTube says why it declined before it says anything about captions, and
     * from the outside "no tracks" means both "this video has none" and "this
     * server may not have this video". Acting on that reason is the difference
     * between telling someone their video is broken and telling them their
     * video is private.
     */
    if (/unavailable|private|been removed|does not exist/i.test(reason)) {
      throw new YoutubeTranscriptVideoUnavailableError(videoId);
    }

    if (playability === "LOGIN_REQUIRED" || playability === "UNPLAYABLE") {
      declined = true;
      continue;
    }

    if (tracks.length === 0) {
      continue;
    }

    // Prefer a human-written track over an auto-generated one.
    const track = tracks.find((entry) => entry.kind !== "asr") ?? tracks[0]!;

    const trackResponse = await fetch(track.baseUrl, {
      headers: {
        "User-Agent": client.userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!trackResponse.ok) {
      notes.push(`${client.name} track HTTP ${trackResponse.status}`);
      continue;
    }

    const content = parseTimedTextXml(await trackResponse.text());

    if (content.trim()) {
      return content;
    }

    notes.push(`${client.name} track parsed to nothing`);
  }

  console.warn(`InnerTube found no transcript for ${videoId}: ${notes.join(" | ")}`);

  throw declined
    ? new YoutubeTranscriptTooManyRequestError()
    : new YoutubeTranscriptDisabledError(videoId);
}

/**
 * Where the off-origin transcript fetch lives.
 *
 * Cloudflare serves the request rather than this server. YouTube answers
 * datacentre addresses with a bot check before it will release captions for
 * anyone else's video, and that judgement is about the network, not the
 * request -- Render, Vercel and the free CORS relays were all measured and
 * all refused. The Worker runs the same InnerTube call that works locally and
 * returns plain text; see frontend/worker.
 */
const TRANSCRIPT_WORKER_URL =
  process.env.YOUTUBE_TRANSCRIPT_WORKER_URL ??
  "https://mindora-youtube-transcript.creative-jackfruit.workers.dev";

/** A transcript fetch should never hold a request open longer than this. */
const WORKER_TIMEOUT_MS = 20_000;

/**
 * Asks the Worker to read the transcript on our behalf.
 *
 * The caption URL InnerTube hands back is signature-bound to whoever asked
 * for it, so it cannot be fetched here and replayed there: the Worker has to
 * do the whole job, which is why this is a request for text rather than an
 * attempt to borrow a URL.
 */
async function fetchViaWorker(videoId: string): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.YOUTUBE_TRANSCRIPT_SECRET) {
    headers["x-proxy-key"] = process.env.YOUTUBE_TRANSCRIPT_SECRET;
  }

  const response = await fetch(TRANSCRIPT_WORKER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ videoId }),
    signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);

    console.error(`TRANSCRIPT WORKER ${response.status} for ${videoId}: ${detail}`);

    if (response.status === 404) {
      throw new YoutubeTranscriptVideoUnavailableError(videoId);
    }

    if (response.status === 429) {
      throw new YoutubeTranscriptTooManyRequestError();
    }

    throw new YoutubeTranscriptNotAvailableError(videoId);
  }

  const data = (await response.json()) as { content?: string };

  if (!data.content?.trim()) {
    throw new YoutubeTranscriptDisabledError(videoId);
  }

  return data.content;
}

/**
 * Reads captions by scraping the watch page.
 *
 * The last resort, and the only path that would survive InnerTube being
 * blocked outright. It depends on YouTube serving the real page rather than a
 * bot check, which is what datacentre IPs are given.
 */
async function fetchViaScrape(videoId: string): Promise<string> {
  const transcript = await YoutubeTranscript.fetchTranscript(videoId, {
    fetch: browserLikeFetch,
  });

  if (transcript.length === 0) {
    throw new YoutubeTranscriptDisabledError(videoId);
  }

  return transcript.map((item) => item.text).join(" ");
}

/**
 * Fetches a transcript, trying each route in turn and keeping the first that
 * works.
 *
 * 1. The official Data API, via the user's OAuth token. `captions.download`
 *    refuses any video the user does not own unless its owner enabled
 *    third-party contributions, which is the default -- so for most public
 *    videos it fails with 403 however good the credentials are. A bonus, never
 *    a guarantee.
 * 2. InnerTube, which returns caption tracks for the same public videos the
 *    Data API refuses.
 * 3. The watch-page scrape, kept because it survives InnerTube being blocked.
 *
 * Every earlier version let an upstream failure abort the request, so one
 * blocked route took YouTube ingestion down with it. Each is now independent,
 * and the error surfaced is the last one rather than whichever came first.
 */
export async function extractYoutubeTranscript(
  url: string,
  clerkUserId?: string,
): Promise<{
  videoId: string;
  content: string;
  via: "oauth" | "innertube" | "worker" | "scrape";
}> {
  const videoId = extractYoutubeVideoId(url);

  if (!videoId) {
    throw new InvalidYoutubeUrlError();
  }

  /*
   * Resolved once and shared. Refreshing a token is a round trip to Google, and
   * both authenticated routes want the same one. A user who has not connected
   * an account is not an error here -- the public routes still run without it.
   */
  let accessToken: string | undefined;

  if (clerkUserId) {
    try {
      accessToken = await getAccessToken(clerkUserId);
    } catch {
      accessToken = undefined;
    }
  }

  const attempts: {
    via: "oauth" | "innertube" | "worker" | "scrape";
    run: () => Promise<string>;
  }[] = [];

  if (accessToken) {
    attempts.push({
      via: "oauth",
      run: () => fetchViaOAuth(videoId, accessToken!),
    });
  }

  attempts.push({
    via: "innertube",
    run: () => fetchViaInnerTube(videoId),
  });
  attempts.push({ via: "worker", run: () => fetchViaWorker(videoId) });
  attempts.push({ via: "scrape", run: () => fetchViaScrape(videoId) });

  let reportedError: unknown;
  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return {
        videoId,
        content: await attempt.run(),
        via: attempt.via,
      };
    } catch (error) {
      lastError = error;

      /*
       * The first public-video route is the one whose reason to believe is
       * worth reporting. Routes disagree -- a private video reads as
       * "unavailable" to InnerTube and as "captions disabled" to the scrape --
       * and the earlier route is the one that looked at the video properly.
       * The Data API is excluded outright: its 403 describes this
       * application's permissions, which tells the user nothing about their
       * video.
       */
      if (attempt.via !== "oauth" && reportedError === undefined) {
        reportedError = error;
      }

      console.warn(
        `YouTube ${attempt.via} route failed for ${videoId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw reportedError ?? lastError;
}

/**
 * A transcript the user cannot be given, described in terms the API can return.
 */
export interface TranscriptFailure {
  status: 400 | 404 | 429 | 501;
  error: string;
}

/**
 * Translates transcript failures into an HTTP-shaped description.
 *
 * Without this every failure surfaced as `500 Failed to ingest YouTube video`,
 * which told users ingestion was broken when the usual cause is that a video
 * has nothing to return, or that YouTube is throttling this server.
 *
 * Returns `null` for anything unrecognised so the caller can fall back to a
 * genuine server error.
 *
 * `YoutubeTranscriptDisabledError` does not necessarily mean the uploader
 * disabled captions: the scraping path raises it whenever YouTube answers with
 * a consent page instead of the video, which is what happens from datacentre
 * IPs.
 */
export function describeTranscriptFailure(
  error: unknown,
): TranscriptFailure | null {
  if (error instanceof InvalidYoutubeUrlError) {
    return {
      status: 400,
      error: "That does not look like a YouTube video link.",
    };
  }

  /*
 * Deliberately does not claim the video has no captions.
 *
 * YouTube does not distinguish "this video has none" from "I will not tell
 * you" in the response, and an authenticated request is the clearer case: it
 * is accepted, the video is reported as playable, and the caption tracks are
 * simply absent. Videos that certainly do have captions reach this branch, so
 * asserting otherwise sends people looking for a problem with their video.
 */
if (error instanceof YoutubeTranscriptDisabledError) {
    return {
      status: 400,
      error:
        "This video's transcript could not be read from this server. It may " +
        "have no captions, or YouTube may be refusing to release them here.",
    };
  }

  if (error instanceof YoutubeTranscriptVideoUnavailableError) {
    return {
      status: 404,
      error: "This video is unavailable. It may be private or removed.",
    };
  }

  if (error instanceof YoutubeTranscriptTooManyRequestError) {
    return {
      status: 429,
      error:
        "YouTube refused to serve a transcript to this server. This is a " +
        "network restriction, not a problem with the video.",
    };
  }

  if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
    return {
      status: 400,
      error: "This video has no captions in any available language.",
    };
  }

  if (error instanceof YoutubeTranscriptNotAvailableError) {
    return {
      status: 400,
      error: "No transcript could be fetched for this video.",
    };
  }

  return null;
}