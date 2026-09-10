import { logger } from '../config/logger.js';

/**
 * In-memory room membership for fan-out.
 *
 * This is deliberately separate from persisted channel membership: rooms model
 * "who is connected and listening right now", while the database models "who
 * has joined". Swapping this for a Redis-backed registry to run several API
 * instances would not touch any handler.
 */
export class RoomRegistry {
  #rooms = new Map();

  join(room, connection) {
    if (!this.#rooms.has(room)) this.#rooms.set(room, new Set());
    this.#rooms.get(room).add(connection);
    connection.rooms.add(room);
  }

  leave(room, connection) {
    const members = this.#rooms.get(room);
    if (members) {
      members.delete(connection);
      if (members.size === 0) this.#rooms.delete(room);
    }
    connection.rooms.delete(room);
  }

  /** Called on disconnect so a dropped socket leaves no references behind. */
  leaveAll(connection) {
    for (const room of [...connection.rooms]) this.leave(room, connection);
  }

  members(room) {
    return this.#rooms.get(room) ?? new Set();
  }

  size(room) {
    return this.members(room).size;
  }

  broadcast(room, event, data, { exclude } = {}) {
    let delivered = 0;
    for (const connection of this.members(room)) {
      if (exclude && connection.id === exclude) continue;
      if (connection.send(event, data)) delivered += 1;
    }
    logger.debug('Broadcast', { room, event, delivered });
    return delivered;
  }

  /**
   * Delivers to the union of several rooms, at most once per connection.
   * Used when an event is addressed both to a channel and to its members
   * individually - a socket in both must not receive it twice.
   */
  deliverUnique(rooms, event, data, { skipRoom } = {}) {
    const seen = new Set();
    let delivered = 0;

    // Sockets in `skipRoom` are already being told a better version of this
    // news - a member watching the channel gets the message itself, not a
    // notification that a message exists.
    if (skipRoom) {
      for (const connection of this.members(skipRoom)) seen.add(connection.id);
    }

    for (const room of rooms) {
      for (const connection of this.members(room)) {
        if (seen.has(connection.id)) continue;
        seen.add(connection.id);
        if (connection.send(event, data)) delivered += 1;
      }
    }

    logger.debug('Fan-out', { rooms, event, delivered });
    return delivered;
  }

  /** Removes a room entirely, e.g. once its channel has been deleted. */
  destroy(room) {
    for (const connection of this.members(room)) connection.rooms.delete(room);
    this.#rooms.delete(room);
  }

  stats() {
    return { rooms: this.#rooms.size };
  }
}
