import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { unauthorized } from '../utils/AppError.js';

const TOKEN_TYPE = 'access';

export class TokenService {
  constructor({ secret = env.auth.jwtSecret, expiresIn = env.auth.jwtExpiresIn } = {}) {
    this.secret = secret;
    this.expiresIn = expiresIn;
  }

  issueAccessToken(user) {
    const payload = { sub: user.id, username: user.username, type: TOKEN_TYPE };
    const token = jwt.sign(payload, this.secret, { expiresIn: this.expiresIn });
    const { exp } = jwt.decode(token);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /**
   * Returns the trusted claims, or throws. The caller must always re-read the
   * user from the database: a token proves identity, never current state.
   */
  verifyAccessToken(token) {
    try {
      const claims = jwt.verify(token, this.secret);
      if (claims.type !== TOKEN_TYPE) {
        throw unauthorized('Invalid authentication token.', ERROR_CODES.TOKEN_INVALID);
      }
      return { userId: claims.sub, username: claims.username };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw unauthorized('Your session has expired. Please sign in again.', ERROR_CODES.TOKEN_EXPIRED);
      }
      if (error.name === 'JsonWebTokenError' || error.name === 'NotBeforeError') {
        throw unauthorized('Invalid authentication token.', ERROR_CODES.TOKEN_INVALID);
      }
      throw error;
    }
  }
}
