import { z } from 'zod';
import { parsePayload } from '../../middlewares/validate.js';
import { uuidField } from '../../validators/rules.js';
import { CLIENT_EVENTS, ROOMS, SERVER_EVENTS } from '../events.js';

const readPayloadSchema = z.object({ channelId: uuidField('channel id') });

/**
 * Marks a channel read for this user.
 *
 * The acknowledgement goes to the user's own room rather than just the calling
 * socket, so a second tab showing the channel list clears its badge at the
 * same moment - without either tab having to poll.
 */
export const markReadHandler = {
  event: CLIENT_EVENTS.CHANNEL_READ,
  requiresAuth: true,
  handle: async (connection, payload, ctx) => {
    const { channelId } = parsePayload(readPayloadSchema, payload);

    const result = await ctx.services.channelService.markChannelRead({ channelId }, connection.user);

    ctx.rooms.broadcast(ROOMS.user(connection.user.id), SERVER_EVENTS.CHANNEL_READ, result);
  },
};
