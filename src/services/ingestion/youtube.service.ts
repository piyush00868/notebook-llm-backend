import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";
import {
  YouTubeNotConnectedError,
  getAccessToken,
} from "../youtube-oauth.service";

const API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey(): string {
  return process.env.YOUTUBE_API_KEY ?? "";
}

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

/**
 * Turns a Google API failure into a typed error.
 *
 * The response body is read and logged because the status alone is
 * ambiguous: 403 covers a missing scope, an API-key restriction, an
 * exhausted quota, and Google's rule that `captions.download` only serves
 * videos the authenticated principal can actually read. Treating every 403 as
 * throttling produced a wrong message, so the reason is surfaced.
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

  // keyInvalid, ipRefererBlocked, accessNotConfigured and forbidden all
  // arrive as 403 and mean a credentials problem, not throttling.
  if (response.status === 429 || reason === "quotaExceeded") {
    return new YoutubeTranscriptTooManyRequestError();
  }

  return new YoutubeTranscriptNotAvailableError(videoId);
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
 * Reads captions through the official Data API with the user's OAuth token.
 *
 * `captions.download` rejects API keys outright -- Google requires a
 * credential that "asserts a principal" -- so this only works once the user
 * has connected a Google account. It is preferred over scraping because it
 * works from any network, including datacentre IPs that YouTube challenges.
 */
async function fetchViaOAuth(
  videoId: string,
  clerkUserId: string,
): Promise<string> {
  const accessToken = await getAccessToken(clerkUserId);

  //
  // Only the OAuth bearer token is sent. Supplying an API key alongside a
  // bearer token asks Google to authenticate twice, which the YouTube Data API
  // rejects -- and it would be the wrong credential for a method that demands
  // a principal anyway.
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

async function fetchViaScrape(videoId: string): Promise<string> {
  const transcript = await YoutubeTranscript.fetchTranscript(videoId);

  if (transcript.length === 0) {
    throw new YoutubeTranscriptDisabledError(videoId);
  }

  return transcript.map((item) => item.text).join(" ");
}

/**
 * Fetches a transcript, preferring the official API.
 *
 * Falls back to scraping when the user has not connected a Google account.
 * That fallback is what works on a residential IP and fails from a datacentre
 * one -- `describeTranscriptFailure` turns the resulting error into an honest
 * message rather than a blanket 500.
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
      // Not connected, or OAuth is not configured: fall through to scraping
      // rather than failing, so existing behaviour is preserved.
      if (
        !(error instanceof YouTubeNotConnectedError) &&
        !(error instanceof Error &&
          /not configured/i.test(error.message))
      ) {
        throw error;
      }
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
        "YouTube is throttling transcript requests right now. Try again shortly.",
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
