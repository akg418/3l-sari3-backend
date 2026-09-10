import { CLIENT_EVENTS, SERVER_EVENTS } from '../events.js';

/**
 * Application-level ping. It complements the protocol-level ping/pong the
 * heartbeat uses: browsers cannot send protocol pings, so this is how a client
 * proves the connection is usable and measures round-trip latency.
 */
export const pingHandler = {
  event: CLIENT_EVENTS.PING,
  requiresAuth: false,
  handle: (connection, _payload, ctx) => {
    connection.send(SERVER_EVENTS.PONG, null, { requestId: ctx.requestId });
  },
};
