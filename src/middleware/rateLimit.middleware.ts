import rateLimit from "express-rate-limit";
import { getAuth } from "@clerk/express";
import type { Request, Response } from "express";

function userIdKeyGenerator(req: Request): string {
  const { userId } = getAuth(req);
  return userId ?? "anonymous";
}

function rateLimitHandler(_req: Request, res: Response): void {
  res.status(429).json({
    error: "Too many requests. Please slow down and try again later.",
  });
}

export const askLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const askHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const youtubeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const youtubeDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 1 day
  max: 30,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const urlLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const textLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  keyGenerator: userIdKeyGenerator,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
});
