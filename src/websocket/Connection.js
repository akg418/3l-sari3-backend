import { randomUUID } from 'node:crypto';
import { SERVER_EVENTS } from './events.js';
import { buildMeta } from '../utils/response.js';

const OPEN = 1;

/**
 * One client socket, plus the state the server keeps about it: who they are
 * (once authenticated), which rooms they are in, and their inbound budget.
 *
 * Nothing here reaches into services - it is purely transport state.
 */
export class Connection {
  constructor(socket, { rateLimit }) {
    this.id = randomUUID();
    this.socket = socket;
    this.user = null;
    this.rooms = new Set();
    this.isAlive = true;
    this.connectedAt = new Date();
    this.rateLimitConfig = rateLimit;
    // The window opens on the first inbound event, not at connect time.
    this.eventWindowStart = null;
    this.eventCount = 0;
  }

  get isAuthenticated() {
    return this.user !== null;
  }

  get userId() {
    return this.user?.id ?? null;
  }

  authenticate(user) {
    this.user = user;
  }

  send(event, data, { requestId } = {}) {
    if (this.socket.readyState !== OPEN) return false;
    this.socket.send(
      JSON.stringify({
        event,
        data: data ?? null,
        ...(requestId ? { requestId } : {}),
        meta: buildMeta(),
      }),
    );
    return true;
  }

  sendError(error, { requestId } = {}) {
    return this.send(SERVER_EVENTS.ERROR, error, { requestId });
  }

  close(code, reason) {
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  terminate() {
    this.socket.terminate();
  }

  /**
   * Fixed-window budget per socket. Cheap, and enough to stop a runaway or
   * malicious client from flooding the server with events.
   */
  consumeRateLimitToken(at = Date.now()) {
    const { windowMs, maxEvents } = this.rateLimitConfig;

    if (this.eventWindowStart === null || at - this.eventWindowStart >= windowMs) {
      this.eventWindowStart = at;
      this.eventCount = 0;
    }

    this.eventCount += 1;
    return this.eventCount <= maxEvents;
  }
}
