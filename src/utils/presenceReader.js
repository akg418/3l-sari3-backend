/**
 * A late-bound window into live presence.
 *
 * The HTTP layer is built before the realtime layer exists, and only the
 * realtime layer knows who is actually connected. Rather than have controllers
 * import from the WebSocket layer - or have the socket registry become a
 * global - the container creates this port and the realtime layer fills it in
 * once it attaches.
 *
 * Unbound, it reports that nobody is online, which is exactly right for a
 * process serving HTTP with no socket layer (a test, or an API-only instance).
 */
export const createPresenceReader = () => {
  let resolveOnlineUserIds = null;

  return {
    bind(resolver) {
      resolveOnlineUserIds = resolver;
    },
    unbind() {
      resolveOnlineUserIds = null;
    },
    get isBound() {
      return resolveOnlineUserIds !== null;
    },
    onlineUserIds(channelId) {
      return resolveOnlineUserIds ? resolveOnlineUserIds(channelId) : new Set();
    },
  };
};
