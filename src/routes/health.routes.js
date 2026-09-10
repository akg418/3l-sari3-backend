import { Router } from 'express';
import mongoose from 'mongoose';
import { sendSuccess } from '../utils/response.js';

export const createHealthRouter = () => {
  const router = Router();

  router.get('/', (_req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;
    sendSuccess(res, {
      status: dbConnected ? 'ok' : 'degraded',
      dependencies: { mongodb: dbConnected ? 'up' : 'down' },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  return router;
};
