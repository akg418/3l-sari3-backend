import { channelIdFromRoom, ROOMS, SERVER_EVENTS } from './events.js';

/**
 * Live presence, derived from the socket registry.
 *
 * Who is *online* in a channel is a property of the connections currently
 * subscribed to it - not of the database, which records who has *joined*. The
 * two are reported separately, so the UI can show a member who is not around
 * right now without pretending they left.
 *
 * A person may hold several sockets (a second tab, a phone), so transitions
 * are computed per user rather than per connection: they come online with
 * their first socket in a channel and go offline only when their last one goes.
 */
export const onlineUserIdsIn = (rooms, channelId) => {
  const online = new Set();
  for (const connection of rooms.members(ROOMS.channel(channelId))) {
    if (connection.userId) online.add(connection.userId);
  }
  return online;
};

export const isUserOnlineIn = (rooms, channelId, userId, { ignoreConnectionId } = {}) => {
  for (const connection of rooms.members(ROOMS.channel(channelId))) {
    if (ignoreConnectionId && connection.id === ignoreConnectionId) continue;
    if (connection.userId === userId) return true;
  }
  return false;
};

const announce = (rooms, channelId, user, isOnline, { exclude } = {}) =>
  rooms.broadcast(
    ROOMS.channel(channelId),
    SERVER_EVENTS.CHANNEL_PRESENCE,
    { channelId, user: { id: user.id, username: user.username }, isOnline },
    { exclude },
  );

/**
 * Subscribes a socket to a channel and announces the arrival only if this is
 * the user's first socket there.
 */
export const attachToChannel = ({ rooms, connection, channelId }) => {
  const wasOnline = isUserOnlineIn(rooms, channelId, connection.userId);
  rooms.join(ROOMS.channel(channelId), connection);

  if (!wasOnline) {
    announce(rooms, channelId, connection.user, true, { exclude: connection.id });
  }
  return { becameOnline: !wasOnline };
};

/** Unsubscribes a socket, announcing departure only when the last one leaves. */
export const detachFromChannel = ({ rooms, connection, channelId }) => {
  rooms.leave(ROOMS.channel(channelId), connection);

  const stillOnline = isUserOnlineIn(rooms, channelId, connection.userId);
  if (!stillOnline) {
    announce(rooms, channelId, connection.user, false);
  }
  return { wentOffline: !stillOnline };
};

/**
 * Tears down a closing socket.
 *
 * This is what keeps presence honest when a tab is closed, a laptop sleeps or
 * a connection is dropped mid-flight - none of which send a leave event.
 */
export const releaseConnection = ({ rooms, connection }) => {
  const channelIds = [...connection.rooms]
    .map(channelIdFromRoom)
    .filter((channelId) => channelId !== null);

  const wentOffline = [];

  for (const channelId of channelIds) {
    // The connection is still registered at this point, so it has to be
    // excluded from the "is anyone else here" question.
    const othersOnline = isUserOnlineIn(rooms, channelId, connection.userId, {
      ignoreConnectionId: connection.id,
    });
    if (!othersOnline) wentOffline.push(channelId);
  }

  rooms.leaveAll(connection);

  if (connection.user) {
    for (const channelId of wentOffline) {
      announce(rooms, channelId, connection.user, false);
    }
  }

  return { wentOffline };
};
