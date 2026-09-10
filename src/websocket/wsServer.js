import { WebSocketServer } from 'ws';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { AppError } from '../utils/AppError.js';
import { Connection } from './Connection.js';
import { CLOSE_CODES, SERVER_EVENTS } from './events.js';
import { resolveHandler } from './handlerRegistry.js';
import { releaseConnection } from './presence.js';

const MAX_FRAME_BYTES = 64 * 1024;

const parseFrame = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(ERROR_CODES.WS_MALFORMED_FRAME, 'Frame is not valid JSON.', { status: 400 });
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.event !== 'string') {
    throw new AppError(ERROR_CODES.WS_MALFORMED_FRAME, 'Frame must be an object with an "event".', {
      status: 400,
    });
  }

  return {
    event: parsed.event,
    data: parsed.data ?? {},
    requestId: typeof parsed.requestId === 'string' ? parsed.requestId.slice(0, 64) : undefined,
  };
};

const isOriginAllowed = (origin) => {
  if (env.corsOrigins.length === 0) return true;
  if (!origin) return !env.isProduction; // non-browser clients (tests, tooling)
  return env.corsOrigins.includes(origin);
};

/**
 * Owns the WebSocket transport: the HTTP upgrade, the connection lifecycle and
 * frame dispatch. All behaviour lives in the handler modules; this file only
 * decides *whether* a frame is allowed to reach one.
 */
export const createWebSocketServer = ({ httpServer, services, rooms, connections }) => {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname !== env.ws.path) {
      socket.destroy();
      return;
    }

    // Browsers do not apply CORS to WebSockets, so the Origin check has to
    // happen here or any site could open a socket against this server.
    if (!isOriginAllowed(request.headers.origin)) {
      logger.warn('Rejected WebSocket upgrade from disallowed origin', {
        origin: request.headers.origin,
      });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket) => {
    const connection = new Connection(socket, { rateLimit: env.ws.rateLimit });
    connections.add(connection);

    // Anonymous sockets get a short grace period to present a token.
    const authTimer = setTimeout(() => {
      if (!connection.isAuthenticated) {
        connection.close(CLOSE_CODES.AUTH_TIMEOUT, 'Authentication timed out');
      }
    }, env.ws.authTimeoutMs);
    authTimer.unref?.();

    connection.send(SERVER_EVENTS.CONNECTION_READY, {
      connectionId: connection.id,
      authTimeoutMs: env.ws.authTimeoutMs,
    });

    socket.on('pong', () => {
      connection.isAlive = true;
    });

    socket.on('message', async (raw) => {
      connection.isAlive = true;
      await dispatch({ connection, raw: raw.toString(), services, rooms, connections });
      if (connection.isAuthenticated) clearTimeout(authTimer);
    });

    socket.on('close', (code) => {
      clearTimeout(authTimer);
      // A closing socket is the only signal that a closed tab, a sleeping
      // laptop or a dropped connection gives us, so presence is settled here
      // rather than trusting clients to announce their own departure.
      releaseConnection({ rooms, connection });
      connections.remove(connection);
      logger.debug('Socket closed', { connectionId: connection.id, code });
    });

    socket.on('error', (error) => {
      logger.warn('Socket error', { connectionId: connection.id, error: error.message });
    });
  });

  wss.on('error', (error) => logger.error('WebSocket server error', { error: error.message }));

  return wss;
};

/**
 * Single funnel for inbound frames: parse, budget, authorise, dispatch, and
 * turn any failure into a structured `error` frame instead of a dropped socket.
 */
const dispatch = async ({ connection, raw, services, rooms, connections }) => {
  let frame;

  try {
    frame = parseFrame(raw);
  } catch (error) {
    connection.sendError(error.toJSON());
    return;
  }

  if (!connection.consumeRateLimitToken()) {
    connection.sendError(
      { code: ERROR_CODES.RATE_LIMITED, message: 'You are sending events too quickly.' },
      { requestId: frame.requestId },
    );
    connection.close(CLOSE_CODES.RATE_LIMITED, 'Rate limit exceeded');
    return;
  }

  const handler = resolveHandler(frame.event);

  if (!handler) {
    connection.sendError(
      { code: ERROR_CODES.WS_UNKNOWN_EVENT, message: `Unknown event "${frame.event}".` },
      { requestId: frame.requestId },
    );
    return;
  }

  if (handler.requiresAuth && !connection.isAuthenticated) {
    connection.sendError(
      { code: ERROR_CODES.WS_NOT_AUTHENTICATED, message: 'Authenticate before sending this event.' },
      { requestId: frame.requestId },
    );
    return;
  }

  try {
    await handler.handle(connection, frame.data, {
      services,
      rooms,
      connections,
      requestId: frame.requestId,
    });
  } catch (error) {
    if (error instanceof AppError) {
      connection.sendError(error.toJSON(), { requestId: frame.requestId });

      // A bad or expired token means this socket can never become useful.
      if (
        error.code === ERROR_CODES.TOKEN_EXPIRED ||
        error.code === ERROR_CODES.TOKEN_INVALID ||
        error.code === ERROR_CODES.UNAUTHORIZED
      ) {
        connection.close(CLOSE_CODES.AUTH_REQUIRED, 'Authentication failed');
      }
      return;
    }

    logger.error('WebSocket handler failed', {
      event: frame.event,
      connectionId: connection.id,
      error: error.message,
      stack: env.isProduction ? undefined : error.stack,
    });

    connection.sendError(
      { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong on our side.' },
      { requestId: frame.requestId },
    );
  }
};
