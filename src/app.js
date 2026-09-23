import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { createApiRouter } from './routes/index.js';
import { createAuthenticateMiddleware } from './middlewares/authenticate.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFoundHandler } from './middlewares/notFound.js';
import { generalRateLimiter } from './middlewares/rateLimiters.js';
import { requestContext } from './middlewares/requestContext.js';

const corsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin requests, curl, server-to-server.
    if (!origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  maxAge: 600,
};

/**
 * Runs the expiration sweep inline, at most once per interval per instance.
 * Serverless functions cannot keep a timer alive between requests, so the
 * traffic itself drives expiry; MongoDB TTL indexes cover idle periods.
 */
const sweepOnRequest = (job, intervalMs) => {
  let lastRunAt = 0;
  return async (_req, _res, next) => {
    const now = Date.now();
    if (now - lastRunAt >= intervalMs) {
      lastRunAt = now;
      await job.tick(new Date(now));
    }
    next();
  };
};

/**
 * Builds the Express application from an already-composed container.
 * It never touches the database or the network, which keeps it trivial to
 * mount inside a test with `supertest`.
 *
 * `sweepExpiredOnRequest` is for hosts without a long-running process.
 */
export const createApp = (container, { sweepExpiredOnRequest = false } = {}) => {
  const app = express();

  if (env.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '64kb' }));
  app.use(requestContext);
  app.use(generalRateLimiter);

  if (sweepExpiredOnRequest) {
    app.use(sweepOnRequest(container.channelExpirationJob, env.channel.sweepIntervalMs));
  }

  const authenticate = createAuthenticateMiddleware({
    tokenService: container.tokenService,
    authService: container.authService,
  });

  app.use(
    '/api',
    createApiRouter({
      authenticate,
      authController: container.authController,
      channelController: container.channelController,
      messageController: container.messageController,
      attachmentController: container.attachmentController,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
