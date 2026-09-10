import { z } from 'zod';
import { parsePayload } from '../../middlewares/validate.js';
import { joinChannelPayloadSchema } from '../../validators/channel.validator.js';
import { uuidField } from '../../validators/rules.js';
import { CLIENT_EVENTS, ROOMS, SERVER_EVENTS } from '../events.js';
import { attachToChannel, detachFromChannel, onlineUserIdsIn } from '../presence.js';
import { LIMITS } from '../../constants/domain.js';

const leavePayloadSchema = z.object({ channelId: uuidField('channel id') });

/**
 * Joining is authoritative: the service re-checks that the channel is alive
 * and, for a private channel, that this user is entitled to it - by ownership,
 * existing membership, or the correct password - before the socket is
 * subscribed. Subscription cannot happen without membership.
 */
export const joinChannelHandler = {
  event: CLIENT_EVENTS.CHANNEL_JOIN,
  requiresAuth: true,
  handle: async (connection, payload, ctx) => {
    const { channelId, password } = parsePayload(joinChannelPayloadSchema, payload);

    const channel = await ctx.services.channelService.joinChannel(
      { channelId, password },
      connection.user,
    );

    attachToChannel({ rooms: ctx.rooms, connection, channelId });

    // Recent history and the roster ride along with the acknowledgement: one
    // round trip to open a channel, and a reconnecting client recovers both
    // anything it missed and who is currently around.
    const [history, members] = await Promise.all([
      ctx.services.messageService.listHistory(
        { channelId, limit: LIMITS.MESSAGE_PAGE_SIZE },
        connection.user,
      ),
      ctx.services.channelService.listMembers(channelId, {
        onlineUserIds: onlineUserIdsIn(ctx.rooms, channelId),
      }),
    ]);

    // Opening a channel is reading it, so the badge clears without the client
    // having to ask separately.
    const read = await ctx.services.channelService.markChannelRead({ channelId }, connection.user);

    connection.send(
      SERVER_EVENTS.CHANNEL_JOINED,
      { channel, messages: history.messages, pageInfo: history.pageInfo, members },
      { requestId: ctx.requestId },
    );

    ctx.rooms.broadcast(ROOMS.user(connection.user.id), SERVER_EVENTS.CHANNEL_READ, read);

    ctx.rooms.broadcast(
      ROOMS.channel(channelId),
      SERVER_EVENTS.CHANNEL_MEMBER_JOINED,
      { channelId, user: { id: connection.user.id, username: connection.user.username } },
      { exclude: connection.id },
    );
  },
};

export const leaveChannelHandler = {
  event: CLIENT_EVENTS.CHANNEL_LEAVE,
  requiresAuth: true,
  handle: async (connection, payload, ctx) => {
    const { channelId } = parsePayload(leavePayloadSchema, payload);

    await ctx.services.channelService.leaveChannel({ channelId }, connection.user);
    detachFromChannel({ rooms: ctx.rooms, connection, channelId });

    connection.send(SERVER_EVENTS.CHANNEL_LEFT, { channelId }, { requestId: ctx.requestId });

    ctx.rooms.broadcast(ROOMS.channel(channelId), SERVER_EVENTS.CHANNEL_MEMBER_LEFT, {
      channelId,
      user: { id: connection.user.id, username: connection.user.username },
    });
  },
};
