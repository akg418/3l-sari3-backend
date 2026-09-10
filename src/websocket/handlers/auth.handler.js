import { z } from 'zod';
import { parsePayload } from '../../middlewares/validate.js';
import { CLIENT_EVENTS, ROOMS, SERVER_EVENTS } from '../events.js';
import { toPublicUser } from '../../serializers/user.serializer.js';

const authenticatePayloadSchema = z.object({
  token: z.string({ required_error: 'An access token is required.' }).min(1),
});

/**
 * A socket starts out anonymous and must present its access token as its first
 * frame. Keeping the token out of the connection URL keeps it out of proxy and
 * server logs, and makes re-authentication after a reconnect an ordinary
 * message rather than a special case.
 */
export const authenticateHandler = {
  event: CLIENT_EVENTS.AUTHENTICATE,
  requiresAuth: false,
  handle: async (connection, payload, ctx) => {
    const { token } = parsePayload(authenticatePayloadSchema, payload);

    const claims = ctx.services.tokenService.verifyAccessToken(token);
    const user = await ctx.services.authService.getUserById(claims.userId);

    connection.authenticate(user);
    ctx.connections.indexByUser(connection);

    // The lobby carries directory-level updates (new channel, channel gone);
    // the personal room carries anything addressed to this user only.
    ctx.rooms.join(ROOMS.LOBBY, connection);
    ctx.rooms.join(ROOMS.user(user.id), connection);

    connection.send(
      SERVER_EVENTS.AUTHENTICATED,
      { user: toPublicUser(user), connectionId: connection.id },
      { requestId: ctx.requestId },
    );
  },
};
