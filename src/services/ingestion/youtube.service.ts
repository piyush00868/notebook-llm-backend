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

function extractYoutubeVideoId(url: string) {
  const parsed = new URL(url);

  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }

  if (
    parsed.hostname === "youtube.com" ||
    parsed.hostname === "www.youtube.com"
  ) {
    return parsed.searchParams.get("v");
  }

  throw new Error("Invalid YouTube URL");
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
  clerkUserId: string,
): Promise<string> {
  const accessToken = await getAccessToken(clerkUserId);
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
 * Reads captions by scraping the watch page.
 *
 * The only path that works for arbitrary public videos -- which is most of
 * them -- but it depends on YouTube serving the real page rather than a bot
 * check, so it fails from datacentre IPs.
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
 * Fetches a transcript, trying the official API first and scraping second.
 *
 * The Data API is only ever a bonus. `captions.download` refuses any video the
 * authenticated user does not own unless its owner enabled third-party
 * contributions, which is the default -- so for most public videos it fails
 * with 403 however good the credentials are. That must not be fatal, because
 * scraping is the only path that works for them.
 *
 * An earlier version fell back solely for "not connected", so a 403 aborted the
 * request and broke ingestion on networks where scraping works fine. Every
 * failure now falls through.
 */
export async function extractYoutubeTranscript(
  url: string,
  clerkUserId?: string,
): Promise<{ videoId: string; content: string; via: "oauth" | "scrape" }> {
  const videoId = extractYoutubeVideoId(url);

  if (!videoId) {
    throw new Error("Could not extract YouTube video ID");
  }

  if (clerkUserId) {
    try {
      return {
        videoId,
        content: await fetchViaOAuth(videoId, clerkUserId),
        via: "oauth",
      };
    } catch (error) {
      console.warn(
        `YouTube Data API unavailable for ${videoId}; falling back to ` +
          `scraping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    videoId,
    content: await fetchViaScrape(videoId),
    via: "scrape",
  };
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
  if (error instanceof YoutubeTranscriptDisabledError) {
    return {
      status: 400,
      error:
        "This video has no captions available to read. Connect a Google account if captions keep failing.",
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
        "YouTube served this server a bot check instead of a transcript. " +
        "Retrying will not help -- the video is fine.",
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