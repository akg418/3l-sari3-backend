import { randomUUID } from 'node:crypto';

/**
 * Attaches a correlation id to every request. It is echoed in error responses
 * and written to the logs, which is what makes a production report traceable
 * without exposing anything about the failure itself.
 */
export const requestContext = (req, res, next) => {
  req.id = req.get('x-request-id') || randomUUID();
  res.set('x-request-id', req.id);
  next();
};
