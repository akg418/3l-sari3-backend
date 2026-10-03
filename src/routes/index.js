import { Router } from 'express';
import { createAuthRouter } from './auth.routes.js';
import { createChannelRouter } from './channel.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createStatsRouter } from './stats.routes.js';

export const createApiRouter = (deps) => {
  const router = Router();

  router.use('/health', createHealthRouter());
  router.use('/auth', createAuthRouter(deps));
  router.use('/channels', createChannelRouter(deps));
  router.use('/stats', createStatsRouter(deps));

  return router;
};
