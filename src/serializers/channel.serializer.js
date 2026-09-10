import { CHANNEL_TYPES } from '../constants/domain.js';

/**
 * The single definition of what a client is allowed to know about a channel.
 * Notably absent: `passwordHash`, `nameKey` and any internal bookkeeping.
 */
export const toPublicChannel = (
  channel,
  { memberCount, isMember, viewerId, onlineCount, unreadCount } = {},
) => ({
  id: channel.id,
  name: channel.name,
  /**
   * The URL-facing identifier. Channel names are already constrained to
   * characters that need no escaping, so this is the name itself - but routing
   * goes through this field so a future rule change has one place to land.
   */
  slug: channel.name,
  type: channel.type,
  isPrivate: channel.type === CHANNEL_TYPES.PRIVATE,
  createdBy: { id: channel.createdBy, username: channel.createdByUsername },
  durationMinutes: channel.durationMinutes,
  createdAt: new Date(channel.createdAt).toISOString(),
  expiresAt: new Date(channel.expiresAt).toISOString(),
  ...(memberCount === undefined ? {} : { memberCount }),
  ...(onlineCount === undefined ? {} : { onlineCount }),
  ...(isMember === undefined ? {} : { isMember }),
  ...(unreadCount === undefined ? {} : { unreadCount }),
  ...(viewerId === undefined ? {} : { isOwner: channel.createdBy === viewerId }),
});

/**
 * The viewer-neutral form, for anything broadcast to more than one person.
 *
 * `isMember` and `isOwner` answer "for whom?", so they cannot travel in a
 * fan-out payload: sending one recipient's answer to a whole room tells
 * everybody else something false about themselves. Strip them at the boundary
 * and let each client keep whatever it already knows about its own membership.
 */
export const toDirectoryChannel = (channel) => {
  const { isMember: _m, isOwner: _o, unreadCount: _u, ...neutral } = channel;
  return neutral;
};

export const toPublicChannelList = (channels, { memberCounts, memberChannelIds, viewerId } = {}) =>
  channels.map((channel) =>
    toPublicChannel(channel, {
      memberCount: memberCounts?.get(channel.id) ?? 0,
      isMember: memberChannelIds ? memberChannelIds.has(channel.id) : undefined,
      viewerId,
    }),
  );
