import { describe, expect, it, vi } from 'vitest';
import { Connection } from '../../src/websocket/Connection.js';

const fakeSocket = () => ({ readyState: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() });

const build = (rateLimit = { windowMs: 1000, maxEvents: 3 }) => {
  const socket = fakeSocket();
  return { socket, connection: new Connection(socket, { rateLimit }) };
};

describe('Connection', () => {
  it('starts out anonymous', () => {
    const { connection } = build();
    expect(connection.isAuthenticated).toBe(false);
    expect(connection.userId).toBeNull();
  });

  it('carries the event name, payload and server time in every frame', () => {
    const { socket, connection } = build();
    connection.send('message:new', { hello: true }, { requestId: 'req-1' });

    const frame = JSON.parse(socket.send.mock.calls[0][0]);
    expect(frame).toMatchObject({ event: 'message:new', data: { hello: true }, requestId: 'req-1' });
    expect(Date.parse(frame.meta.serverTime)).not.toBeNaN();
  });

  it('does not write to a socket that is no longer open', () => {
    const { socket, connection } = build();
    socket.readyState = 3;

    expect(connection.send('ping')).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });

  describe('rate limiting', () => {
    it('allows events up to the budget and refuses the rest', () => {
      const { connection } = build({ windowMs: 1000, maxEvents: 3 });

      expect([1, 2, 3].map(() => connection.consumeRateLimitToken(1000))).toEqual([true, true, true]);
      expect(connection.consumeRateLimitToken(1000)).toBe(false);
    });

    it('refills once the window rolls over', () => {
      const { connection } = build({ windowMs: 1000, maxEvents: 2 });

      connection.consumeRateLimitToken(0);
      connection.consumeRateLimitToken(0);
      expect(connection.consumeRateLimitToken(0)).toBe(false);

      expect(connection.consumeRateLimitToken(1001)).toBe(true);
    });
  });
});
