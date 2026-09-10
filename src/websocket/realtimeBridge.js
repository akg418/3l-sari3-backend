import { DOMAIN_EVENTS } from '../utils/domainEvents.js';
import { logger } from '../config/logger.js';
import { ROOMS, SERVER_EVENTS } from './events.js';
import { onlineUserIdsIn } from './presence.js';
import { toDirectoryChannel } from '../serializers/channel.serializer.js';

/**
 * The only place that knows how a domain event becomes a realtime message.
 *
 * Producers (services, the expiration job) emit plain domain events and stay
 * transport-agnostic; this adapter decides who should hear about them.
 */
export const registerRealtimeBridge = ({ eventBus, rooms, channelService }) => {
  /**
   * Pushes the full roster to a channel.
   *
   * Membership changes are rare, so a snapshot is sent rather than a delta -
   * it cannot drift out of step with the server, which a stream of deltas
   * eventually can. Per-socket online/offline transitions are the exception
   * and are sent as deltas from the presence module, since they are frequent
   * and need no database read.
   */
  const broadcastRoster = async (channelId) => {
    const room = ROOMS.channel(channelId);
    if (rooms.size(room) === 0) return;

    try {
      const members = await channelService.listMembers(channelId, {
        onlineUserIds: onlineUserIdsIn(rooms, channelId),
      });
      rooms.broadcast(room, SERVER_EVENTS.CHANNEL_MEMBERS, { channelId, members });
    } catch (error) {
      // An expired channel is the common case here, and it has its own event.
      logger.debug('Skipped roster broadcast', { channelId, error: error.message });
    }
  };

  const unsubscribes = [
    /**
     * A new channel shows up in everyone's directory immediately.
     *
     * Stripped again here, at the boundary where one payload reaches many
     * people: a viewer-scoped field in a broadcast would tell every recipient
     * the creator's answer about themselves.
     */
    eventBus.on(DOMAIN_EVENTS.CHANNEL_CREATED, ({ channel }) => {
      rooms.broadcast(ROOMS.LOBBY, SERVER_EVENTS.CHANNEL_CREATED, {
        channel: toDirectoryChannel(channel),
      });
    }),

    eventBus.on(DOMAIN_EVENTS.CHANNEL_MEMBER_JOINED, ({ channel }) => broadcastRoster(channel.id)),
    eventBus.on(DOMAIN_EVENTS.CHANNEL_MEMBER_LEFT, ({ channelId }) => broadcastRoster(channelId)),

    /**
     * The one-minute warning is addressed to the channel's members: the people
     * looking at it right now, plus their other sessions, which may be showing
     * the channel in "My Channels".
     */
    eventBus.on(DOMAIN_EVENTS.CHANNEL_EXPIRING, (payload) => {
      const targets = [
        ROOMS.channel(payload.channelId),
        ...(payload.memberIds ?? []).map((userId) => ROOMS.user(userId)),
      ];

      rooms.deliverUnique(targets, SERVER_EVENTS.CHANNEL_EXPIRING, {
        channelId: payload.channelId,
        channelName: payload.channelName,
        expiresAt: payload.expiresAt,
        secondsRemaining: payload.secondsRemaining,
        message: 'This channel will be deleted in 1 minute.',
      });
    }),

    /**
     * Expiry goes to the whole lobby: every client has to drop the channel
     * from its lists, and anyone sitting inside it has to be sent back to the
     * directory. The room is then discarded.
     */
    eventBus.on(DOMAIN_EVENTS.CHANNEL_EXPIRED, (payload) => {
      rooms.broadcast(ROOMS.LOBBY, SERVER_EVENTS.CHANNEL_EXPIRED, {
        channelId: payload.channelId,
        channelName: payload.channelName,
        reason: 'expired',
        message: 'This channel has expired and was deleted.',
      });

      rooms.destroy(ROOMS.channel(payload.channelId));
      logger.debug('Channel room destroyed', { channelId: payload.channelId });
    }),

    /**
     * Single fan-out path for messages, whatever created them.
     *
     * Two audiences, deliberately different. People watching the channel get
     * the message. Members who are connected but looking elsewhere get a
     * contentless nudge so their unread badge can move - they are entitled to
     * the content, but sending it to a client that is not showing the channel
     * is wasted bandwidth, and the badge is all the UI needs.
     */
    eventBus.on(DOMAIN_EVENTS.MESSAGE_CREATED, async ({ message }) => {
      const channelRoom = ROOMS.channel(message.channelId);
      rooms.broadcast(channelRoom, SERVER_EVENTS.MESSAGE_NEW, { message });

      const memberIds = await channelService.listMemberIds(message.channelId);
      const targets = memberIds
        .filter((userId) => userId !== message.sender.id)
        .map((userId) => ROOMS.user(userId));

      if (targets.length === 0) return;

      rooms.deliverUnique(
        targets,
        SERVER_EVENTS.CHANNEL_ACTIVITY,
        {
          channelId: message.channelId,
          messageId: message.id,
          sender: message.sender,
          createdAt: message.createdAt,
        },
        { skipRoom: channelRoom },
      );
    }),
  ];

  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
};
