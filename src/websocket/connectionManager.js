import { logger } from '../config/logger.js';
import { CLOSE_CODES } from './events.js';

/**
 * Owns the set of live connections and the liveness heartbeat.
 *
 * Sockets are indexed by user id as well, because a person legitimately has
 * several (a second tab, a phone) and server-side notifications must reach
 * every one of them.
 */
export class ConnectionManager {
  #connections = new Map();
  #byUser = new Map();
  #heartbeat = null;

  constructor({ heartbeatIntervalMs }) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  add(connection) {
    this.#connections.set(connection.id, connection);
  }

  /** Indexing by user is only possible once the socket has authenticated. */
  indexByUser(connection) {
    const userId = connection.userId;
    if (!userId) return;
    if (!this.#byUser.has(userId)) this.#byUser.set(userId, new Set());
    this.#byUser.get(userId).add(connection);
  }

  remove(connection) {
    this.#connections.delete(connection.id);

    const userId = connection.userId;
    if (!userId) return;

    const sockets = this.#byUser.get(userId);
    if (!sockets) return;
    sockets.delete(connection);
    if (sockets.size === 0) this.#byUser.delete(userId);
  }

  byUser(userId) {
    return this.#byUser.get(userId) ?? new Set();
  }

  all() {
    return this.#connections.values();
  }

  get count() {
    return this.#connections.size;
  }

  startHeartbeat() {
    if (this.#heartbeat) return;

    this.#heartbeat = setInterval(() => {
      for (const connection of this.#connections.values()) {
        // A socket that missed the previous round is presumed dead: half-open
        // TCP connections would otherwise linger and leak room membership.
        if (!connection.isAlive) {
          logger.debug('Terminating unresponsive socket', { connectionId: connection.id });
          connection.terminate();
          continue;
        }
        connection.isAlive = false;
        connection.socket.ping();
      }
    }, this.heartbeatIntervalMs);

    this.#heartbeat.unref?.();
  }

  stopHeartbeat() {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  closeAll(code = CLOSE_CODES.INTERNAL_ERROR, reason = 'Server shutting down') {
    for (const connection of this.#connections.values()) connection.close(code, reason);
  }
}
