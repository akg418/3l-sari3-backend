import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { attachWebSocketLayer } from './websocket/index.js';

/**
 * Process entry point: wire the graph, open the port, and make sure a restart
 * or a crash tears everything down in a defined order.
 */
const bootstrap = async () => {
  await connectDatabase();

  const container = createContainer();

  await container.storage.ensureReady();
  // MongoDB's TTL monitor can remove a channel while this process is down,
  // which leaves its files with no owner. Reconciling at startup is what keeps
  // the "nothing outlives its channel" promise true across restarts.
  await container.channelCleanupService.reconcileStorage();

  const app = createApp(container);
  const httpServer = http.createServer(app);

  const realtime = attachWebSocketLayer({ httpServer, container });
  container.channelExpirationJob.start();

  await new Promise((resolve) => httpServer.listen(env.port, resolve));
  logger.info('HTTP server listening', {
    port: env.port,
    env: env.nodeEnv,
    wsPath: env.ws.path,
  });

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    container.channelExpirationJob.stop();
    await realtime.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnectDatabase();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void shutdown(signal));
  }

  // An unhandled rejection or exception leaves the process in an unknown
  // state; log it and let the supervisor restart us cleanly.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    void shutdown('uncaughtException');
  });
};

bootstrap().catch((error) => {
  logger.error('Failed to start server', { error: error.message, stack: error.stack });
  process.exit(1);
});
