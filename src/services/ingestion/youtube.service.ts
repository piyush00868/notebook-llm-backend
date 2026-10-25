/**
 * YouTube transcript extraction via Supadata.
 *
 * YouTube blocks datacenter IPs (Render, Vercel, Cloudflare), so scraping the
 * transcript directly from the server returns 429 / bot-check pages. Supadata
 * fetches it from its own infrastructure and returns plain text.
 *
 * Exports are unchanged, so `document.controller.ts` needs no edits:
 *   - extractYoutubeTranscript(url) -> { content, language? }
 *   - describeTranscriptFailure(error) -> { status, error } | null
 *
 * Env:
 *   SUPADATA_API_KEY   required
 *   SUPADATA_MODE      optional: "native" (default) | "auto" | "generate"
 *                      "native" only fetches existing captions, which keeps
 *                      free-plan credits from being spent on AI transcription.
 */

import { db } from "../../prisma/db";

const SUPADATA_ENDPOINT = "https://api.supadata.ai/v1/transcript";
const REQUEST_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type TranscriptFailureCode =
  | "INVALID_URL"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM";

export class TranscriptError extends Error {
  readonly code: TranscriptFailureCode;

  constructor(code: TranscriptFailureCode, message: string) {
    super(message);
    this.name = "TranscriptError";
    this.code = code;
  }
}

export type YoutubeTranscript = {
  content: string;
  language?: string;
};

type SupadataTranscriptResponse = {
  content?: unknown;
  lang?: string;
  jobId?: string;
  error?: string;
  message?: string;
};

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

function extractYoutubeVideoIdFromUrl(url: string): string {
  const parsed = new URL(url.trim());
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }

  if (hostname === "youtube.com" || hostname === "m.youtube.com" || hostname === "music.youtube.com") {
    return parsed.searchParams.get("v") ?? "";
  }

  throw new TranscriptError("INVALID_URL", "Not a YouTube URL");
}

function normaliseYoutubeUrl(raw: string): string {
  let parsed: URL;

  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new TranscriptError("INVALID_URL", "Invalid YouTube URL");
  }

  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new TranscriptError("INVALID_URL", "Not a YouTube URL");
  }

  return parsed.toString();
}

function resolveMode(): "native" | "auto" | "generate" {
  const mode = (process.env.SUPADATA_MODE ?? "native").toLowerCase();

  return mode === "auto" || mode === "generate" ? mode : "native";
}

export async function extractYoutubeTranscript(
  url: string,
): Promise<YoutubeTranscript> {
  const apiKey = process.env.SUPADATA_API_KEY;

  if (!apiKey) {
    // A configuration fault, not a user error: surfaces as a logged 500.
    throw new Error("SUPADATA_API_KEY is not set");
  }

  const videoId = extractYoutubeVideoIdFromUrl(url);

  // Check cache first
  try {
    const cache: any = db.orm.public;
    const cached = await cache.YoutubeTranscriptCache.findUnique({
      where: { videoId },
    });
    if (cached) {
      const age = Date.now() - new Date(cached.createdAt).getTime();
      if (age < CACHE_TTL_MS) {
        console.log(`Cache hit for video ${videoId} (${Math.round(age / 1000 / 60)} min old)`);
        return { content: cached.content, language: cached.language ?? undefined };
      }
      // Expired: delete and refetch
      await cache.YoutubeTranscriptCache.delete({ where: { videoId } });
    }
  } catch (e) {
    console.error(`Cache read failed for video ${videoId}:`, e);
    // Cache lookup failure is non-fatal; proceed to fetch
  }

  const videoUrl = normaliseYoutubeUrl(url);

  const query = new URLSearchParams({
    url: videoUrl,
    text: "true",
    mode: resolveMode(),
  });

  let response: Response;

  try {
    response = await fetch(`${SUPADATA_ENDPOINT}?${query.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TranscriptError("TIMEOUT", "Transcript request timed out");
    }

    throw new TranscriptError("UPSTREAM", "Could not reach transcript service");
  }

  const body = (await response
    .json()
    .catch(() => ({}))) as SupadataTranscriptResponse;

  if (response.status === 429) {
    throw new TranscriptError("RATE_LIMITED", "Transcript service at capacity");
  }

  if (response.status === 401 || response.status === 403) {
    // Bad or exhausted API key: server-side problem, logged as a 500.
    throw new Error(
      `Supadata rejected the API key (${response.status}): ${body.message ?? body.error ?? "no detail"}`,
    );
  }

  if (response.status === 400) {
    throw new TranscriptError("INVALID_URL", body.message ?? "Invalid request");
  }

  // 404 / 206 are how Supadata reports "this video has no transcript".
  if (response.status === 404 || response.status === 206) {
    throw new TranscriptError("UNAVAILABLE", "No transcript available");
  }

  if (!response.ok) {
    throw new TranscriptError(
      "UPSTREAM",
      `Transcript service error (${response.status})`,
    );
  }

  // 202 means an async job was queued (only happens for AI generation of long
  // videos). Native mode never does this, so treat it as unavailable rather
  // than polling inside a request handler.
  if (response.status === 202 || body.jobId) {
    throw new TranscriptError(
      "UNAVAILABLE",
      "Transcript is not available without AI generation",
    );
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";

  if (!content) {
    throw new TranscriptError("UNAVAILABLE", "Transcript is empty");
  }

  const result = {
    content,
    ...(body.lang ? { language: body.lang } : {}),
  };

  // Cache the result
  try {
    const cache: any = db.orm.public;
    await cache.YoutubeTranscriptCache.upsert({
      where: { videoId },
      update: { content, language: body.lang ?? null },
      create: { videoId, content, language: body.lang ?? null },
    });
    console.log(`Cached transcript for video ${videoId}`);
  } catch (e) {
    console.error(`Cache write failed for video ${videoId}:`, e);
    // Cache write failure is non-fatal; return the result anyway
  }

  return result;
}

/**
 * Maps a failure to the HTTP response the controller should send.
 * Returns null for anything unrecognised so the controller logs it and
 * answers with a generic 500.
 */
export function describeTranscriptFailure(
  error: unknown,
): { status: number; error: string } | null {
  if (!(error instanceof TranscriptError)) {
    return null;
  }

  switch (error.code) {
    case "INVALID_URL":
      return {
        status: 400,
        error: "That does not look like a valid YouTube video link.",
      };

    case "UNAVAILABLE":
      return {
        status: 422,
        error:
          "This video has no transcript we can read. Try another video, or paste the transcript as a text source.",
      };

    case "RATE_LIMITED":
      return {
        status: 503,
        error:
          "YouTube import is busy right now. Try again in a little while, or paste the transcript as a text source.",
      };

    case "TIMEOUT":
      return {
        status: 504,
        error: "Fetching the transcript took too long. Please try again.",
      };

    case "UPSTREAM":
      return {
        status: 502,
        error:
          "The transcript service had a problem. Try again, or paste the transcript as a text source.",
      };
  }
}
