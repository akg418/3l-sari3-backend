import { z } from 'zod';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { AppError } from '../utils/AppError.js';
import { sendError } from '../utils/response.js';
import { formatZodIssues } from './validate.js';
import { isDuplicateKeyError } from '../repositories/BaseRepository.js';

/**
 * Translates anything thrown anywhere in the request pipeline into the single
 * error envelope the API promises. Unknown failures are logged in full and
 * reported as an opaque INTERNAL_ERROR - stack traces and driver messages
 * never reach a client.
 */
const normalize = (error) => {
  if (error instanceof AppError) {
    return { status: error.status, body: error.toJSON() };
  }

  if (error instanceof z.ZodError) {
    return {
      status: 422,
      body: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The submitted data is invalid.',
        details: formatZodIssues(error),
      },
    };
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return {
      status: 422,
      body: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The submitted data is invalid.',
        details: Object.entries(error.errors).map(([field, issue]) => ({
          field,
          message: issue.message,
        })),
      },
    };
  }

  if (isDuplicateKeyError(error)) {
    return {
      status: 409,
      body: { code: ERROR_CODES.BAD_REQUEST, message: 'That value is already taken.' },
    };
  }

  // Body-parser rejects malformed JSON with a SyntaxError carrying a status.
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return {
      status: 400,
      body: { code: ERROR_CODES.BAD_REQUEST, message: 'Request body is not valid JSON.' },
    };
  }

  if (error?.message === 'CORS_ORIGIN_NOT_ALLOWED') {
    return {
      status: 403,
      body: { code: ERROR_CODES.BAD_REQUEST, message: 'Origin is not allowed.' },
    };
  }

  return {
    status: 500,
    body: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong on our side.' },
  };
};

/** Express identifies error middleware by its four-argument signature. */
export const errorHandler = (error, req, res, _next) => {
  const { status, body } = normalize(error);

  const logMeta = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status,
    code: body.code,
  };

  if (status >= 500) {
    logger.error(error.message ?? 'Unhandled error', {
      ...logMeta,
      stack: env.isProduction ? undefined : error.stack,
    });
  } else {
    logger.debug('Request failed', logMeta);
  }

  return sendError(res, body, { status, meta: { requestId: req.id } });
};
