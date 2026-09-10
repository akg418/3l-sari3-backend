import multer from 'multer';
import { env } from '../config/env.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { LIMITS } from '../constants/domain.js';
import { AppError } from '../utils/AppError.js';

/**
 * Multipart handling for attachments.
 *
 * Files are buffered in memory rather than written straight to disk, because
 * the type check reads the leading bytes: nothing reaches storage until it has
 * been identified and accepted. The size ceiling here is the outer bound -
 * multer aborts a stream that exceeds it, so an oversized upload costs no more
 * than that - and the per-kind limits are applied afterwards, once we know
 * whether the file is an image.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.uploads.maxAnyBytes,
    files: 1,
    fields: 4,
    parts: 6,
  },
});

const translateMulterError = (error) => {
  if (!(error instanceof multer.MulterError)) return error;

  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new AppError(
        ERROR_CODES.ATTACHMENT_TOO_LARGE,
        `That file is too large. The maximum is ${Math.round(env.uploads.maxAnyBytes / (1024 * 1024))} MB.`,
        { status: 413 },
      );
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return new AppError(
        ERROR_CODES.ATTACHMENT_LIMIT_REACHED,
        `Upload one file at a time, up to ${LIMITS.ATTACHMENTS_PER_MESSAGE} per message.`,
        { status: 422 },
      );
    default:
      return new AppError(ERROR_CODES.UPLOAD_FAILED, 'That upload could not be read.', {
        status: 400,
      });
  }
};

/** Accepts a single file under the field name `file`. */
export const uploadSingleAttachment = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (error) return next(translateMulterError(error));
    return next();
  });
};
