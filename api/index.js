import { connectDatabase } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/app.js';

/**
 * Vercel serverless entry point.
 *
 * No WebSocket, no timers, no disk: the app is built once per warm instance
 * and reused, and expiry is swept inline as requests arrive.
 */
let appPromise = null;

const buildApp = async () => {
  await connectDatabase();
  const container = createContainer();
  await container.storage.ensureReady();
  return createApp(container, { sweepExpiredOnRequest: true });
};

export default async function handler(req, res) {
  appPromise ??= buildApp().catch((error) => {
    // Let the next request retry instead of caching the failure.
    appPromise = null;
    throw error;
  });

  try {
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    logger.error('Failed to initialise API', { error: error.message });
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is starting. Try again.' },
      }),
    );
  }
}
