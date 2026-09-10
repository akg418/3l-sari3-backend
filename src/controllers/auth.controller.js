import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';
import { toPublicUser } from '../serializers/user.serializer.js';

/** Controllers only translate HTTP <-> service calls; no business rules live here. */
export class AuthController {
  constructor({ authService }) {
    this.authService = authService;
  }

  register = asyncHandler(async (req, res) => {
    const result = await this.authService.register(req.validated.body);
    sendSuccess(
      res,
      { user: toPublicUser(result.user), token: result.token, expiresAt: result.expiresAt },
      { status: 201 },
    );
  });

  login = asyncHandler(async (req, res) => {
    const result = await this.authService.login(req.validated.body);
    sendSuccess(res, {
      user: toPublicUser(result.user),
      token: result.token,
      expiresAt: result.expiresAt,
    });
  });

  me = asyncHandler(async (req, res) => {
    sendSuccess(res, { user: toPublicUser(req.user) });
  });
}
