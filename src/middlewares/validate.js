import { z } from 'zod';
import { validationError } from '../utils/AppError.js';

export const formatZodIssues = (error) =>
  error.issues.map((issue) => ({
    field: issue.path.filter((segment) => segment !== 'body').join('.') || 'root',
    message: issue.message,
  }));

/**
 * Validates and *replaces* the request input.
 *
 * Handlers read from `req.validated` only, so unvalidated or extra client
 * fields can never reach a service by accident.
 */
export const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse({
    body: req.body ?? {},
    params: req.params ?? {},
    query: req.query ?? {},
  });

  if (!result.success) {
    return next(validationError(formatZodIssues(result.error)));
  }

  req.validated = {
    body: result.data.body ?? {},
    params: result.data.params ?? {},
    query: result.data.query ?? {},
  };
  return next();
};

/** Validates a bare payload object, used by the WebSocket handlers. */
export const parsePayload = (schema, payload) => {
  const result = schema.safeParse(payload ?? {});
  if (!result.success) {
    throw validationError(formatZodIssues(result.error));
  }
  return result.data;
};

export const isZodError = (error) => error instanceof z.ZodError;
