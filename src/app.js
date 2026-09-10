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
 * Builds the Express application from an already-composed container.
 * It never touches the database or the network, which keeps it trivial to
 * mount inside a test with `supertest`.
 */
export const createApp = (container) => {
  const app = express();

  if (env.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '64kb' }));
  app.use(requestContext);
  app.use(generalRateLimiter);

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
