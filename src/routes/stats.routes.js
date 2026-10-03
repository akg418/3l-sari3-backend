import { Router } from 'express';
import { statsRateLimiter } from '../middlewares/rateLimiters.js';

/**
 * Guarded by an access code rather than a user account, so it can be shared
 * with someone who has no login. Failed attempts are rate-limited to stop guessing.
 */
export const createStatsRouter = ({ statsController }) => {
  const router = Router();
  router.get('/', statsRateLimiter, statsController.get);
  return router;
};
