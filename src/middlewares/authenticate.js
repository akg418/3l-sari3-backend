import { ERROR_CODES } from '../constants/errorCodes.js';
import { unauthorized } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const extractBearerToken = (req) => {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!/^bearer$/i.test(scheme ?? '') || !token) return null;
  return token.trim();
};

/**
 * Resolves the caller from the Authorization header.
 *
 * The user is re-read from the database on every request: the token proves who
 * someone is, never what they are currently allowed to do or that they still
 * exist.
 */
export const createAuthenticateMiddleware = ({ tokenService, authService }) =>
  asyncHandler(async (req, _res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      throw unauthorized('Authentication is required.', ERROR_CODES.UNAUTHORIZED);
    }

    const claims = tokenService.verifyAccessToken(token);
    const user = await authService.getUserById(claims.userId);

    req.user = user;
    next();
  });
