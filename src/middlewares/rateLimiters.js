import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { sendError } from '../utils/response.js';

const handler = (_req, res) =>
  sendError(
    res,
    {
      code: ERROR_CODES.RATE_LIMITED,
      message: 'Too many requests. Please slow down and try again shortly.',
    },
    { status: 429 },
  );

const baseOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  // Rate limiting is noise in tests; the limiters themselves are covered
  // separately rather than by every request an integration test makes.
  skip: () => env.isTest,
};

export const generalRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: env.rateLimit.general.windowMs,
  limit: env.rateLimit.general.max,
});

/** Uploads are the most expensive request the API serves, so they get their own budget. */
export const uploadRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: env.rateLimit.upload.windowMs,
  limit: env.rateLimit.upload.max,
});

/** Tighter budget on credential endpoints to blunt brute-force attempts. */
export const authRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: env.rateLimit.auth.windowMs,
  limit: env.rateLimit.auth.max,
  skipSuccessfulRequests: false,
});

/** Only wrong access codes count, so viewing the stats page never locks anyone out. */
export const statsRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: env.rateLimit.auth.windowMs,
  limit: env.rateLimit.auth.max,
  skipSuccessfulRequests: true,
});
