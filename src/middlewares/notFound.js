import { ERROR_CODES } from '../constants/errorCodes.js';
import { notFound } from '../utils/AppError.js';

export const notFoundHandler = (req, _res, next) => {
  next(notFound(ERROR_CODES.NOT_FOUND, `Cannot ${req.method} ${req.originalUrl}`));
};
