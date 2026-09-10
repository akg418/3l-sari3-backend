import { Router } from 'express';
import { validate } from '../middlewares/validate.js';
import { authRateLimiter } from '../middlewares/rateLimiters.js';
import { loginSchema, registerSchema } from '../validators/auth.validator.js';

export const createAuthRouter = ({ authController, authenticate }) => {
  const router = Router();

  router.post('/register', authRateLimiter, validate(registerSchema), authController.register);
  router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
  router.get('/me', authenticate, authController.me);

  return router;
};
