import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

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
 * A `fetch` shaped like a browser's, for the library to make its calls with.
 *
 * `youtube-transcript` accepts this through `config.fetch`, which is the only
 * lever it exposes over how requests look on the wire.
 */
const MODERN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
 * check, which is what datacentre IPs are given.
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
 * Fetches a transcript by scraping the watch page.
 *
 * No Google account is involved: the official Data API's `captions.download`
 * refuses any video the authenticated user does not own unless its owner
 * enabled third-party contributions, which is the default -- so OAuth can
 * never retrieve an arbitrary public transcript. Scraping is the only path
 * that works for them, and it needs no credentials at all.
 */
export async function extractYoutubeTranscript(
  url: string,
): Promise<{ videoId: string; content: string; via: "scrape" }> {
  const videoId = extractYoutubeVideoId(url);

  if (!videoId) {
    throw new InvalidYoutubeUrlError();
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
  status: 400 | 404 | 429;
  error: string;
}

/**
 * Translates transcript failures into an HTTP-shaped description.
 *
 * Without this every failure surfaced as `500 Failed to ingest YouTube
 * video`, which told users ingestion was broken when the usual cause is that
 * a video has nothing to return, or that YouTube is throttling this server.
 *
 * Returns `null` for anything unrecognised so the caller can fall back to a
 * genuine server error.
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
