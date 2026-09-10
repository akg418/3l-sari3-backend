/** Events a client may send. Anything else is rejected as an unknown event. */
export const CLIENT_EVENTS = Object.freeze({
  AUTHENTICATE: 'auth:authenticate',
  PING: 'ping',
  CHANNEL_JOIN: 'channel:join',
  CHANNEL_LEAVE: 'channel:leave',
  MESSAGE_SEND: 'message:send',
  /** "I am looking at this channel" - moves the unread cutoff forward. */
  CHANNEL_READ: 'channel:read',
});

/** Events the server emits. */
export const SERVER_EVENTS = Object.freeze({
  CONNECTION_READY: 'connection:ready',
  AUTHENTICATED: 'auth:authenticated',
  PONG: 'pong',

  CHANNEL_CREATED: 'channel:created',
  CHANNEL_JOINED: 'channel:joined',
  CHANNEL_LEFT: 'channel:left',
  CHANNEL_MEMBER_JOINED: 'channel:member_joined',
  CHANNEL_MEMBER_LEFT: 'channel:member_left',
  CHANNEL_EXPIRING: 'channel:expiring',
  CHANNEL_EXPIRED: 'channel:expired',

  /** Full roster snapshot: sent on join and whenever membership changes. */
  CHANNEL_MEMBERS: 'channel:members',
  /** A single member came online or went offline. Cheap, no database read. */
  CHANNEL_PRESENCE: 'channel:presence',

  MESSAGE_NEW: 'message:new',
  MESSAGE_ACK: 'message:ack',

  /**
   * A message landed in a channel you belong to but are not currently
   * watching. Carries no content - just enough to move an unread badge.
   */
  CHANNEL_ACTIVITY: 'channel:activity',
  /** Your read cutoff moved, so your other sessions can clear their badge. */
  CHANNEL_READ: 'channel:read',

  ERROR: 'error',
});

/**
 * Application close codes (the 4000-4999 range is reserved for applications).
 * The client uses these to decide whether reconnecting makes sense.
 */
export const CLOSE_CODES = Object.freeze({
  AUTH_REQUIRED: 4401,
  AUTH_TIMEOUT: 4408,
  RATE_LIMITED: 4429,
  INTERNAL_ERROR: 4500,
});

/** Rooms are the fan-out unit. Everything else is derived from these names. */
export const ROOMS = Object.freeze({
  /** Every authenticated socket, used for channel directory updates. */
  LOBBY: 'lobby',
  channel: (channelId) => `channel:${channelId}`,
  user: (userId) => `user:${userId}`,
});

const CHANNEL_ROOM_PREFIX = 'channel:';

/** Recovers the channel id from a room name, or null if it is not a channel room. */
export const channelIdFromRoom = (room) =>
  room.startsWith(CHANNEL_ROOM_PREFIX) ? room.slice(CHANNEL_ROOM_PREFIX.length) : null;
