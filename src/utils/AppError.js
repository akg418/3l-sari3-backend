import { ERROR_CODES } from '../constants/errorCodes.js';

/**
 * Every expected failure in the system is an AppError. Anything else that
 * reaches the error middleware is treated as an unexpected bug and is not
 * echoed back to the client.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const badRequest = (message, details) =>
  new AppError(ERROR_CODES.BAD_REQUEST, message, { status: 400, details });

export const validationError = (details, message = 'The submitted data is invalid.') =>
  new AppError(ERROR_CODES.VALIDATION_ERROR, message, { status: 422, details });

export const unauthorized = (message = 'Authentication is required.', code = ERROR_CODES.UNAUTHORIZED) =>
  new AppError(code, message, { status: 401 });

export const forbidden = (code, message) => new AppError(code, message, { status: 403 });

export const notFound = (code, message) => new AppError(code, message, { status: 404 });

export const conflict = (code, message) => new AppError(code, message, { status: 409 });
