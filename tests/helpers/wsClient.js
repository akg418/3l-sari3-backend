import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { env } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { createDomainEventBus } from '../../src/utils/domainEvents.js';
import { attachWebSocketLayer } from '../../src/websocket/index.js';
import { LocalFileStorage } from '../../src/services/storage/index.js';

/** Boots the real HTTP + WebSocket stack on an ephemeral port. */
export const startTestServer = async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ephemera-ws-'));
  const storage = new LocalFileStorage({ directory: storageRoot });

  const eventBus = createDomainEventBus();
  const container = createContainer({ eventBus, overrides: { storage } });
  const app = createApp(container);
  const httpServer = http.createServer(app);
  const realtime = attachWebSocketLayer({ httpServer, container });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  return {
    container,
    eventBus,
    realtime,
    storage,
    storageRoot,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${env.ws.path}`,
    close: async () => {
      await realtime.close();
      await new Promise((resolve) => httpServer.close(resolve));
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
  };
};

/**
 * Polls until a condition holds. Closing a socket is observed by the client
 * before the server has finished cleaning up after it, so assertions about
 * server-side state need to wait for that to land.
 */
export const waitUntil = async (predicate, { timeout = 2000, interval = 10 } = {}) => {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error('Timed out waiting for condition');
};

/**
 * Test-side WebSocket client.
 *
 * Every inbound frame is buffered, so a test can await an event that has
 * already arrived without racing the socket.
 */
export class TestClient {
  #frames = [];
  #waiters = [];

  constructor(url) {
    this.url = url;
    this.socket = new WebSocket(url);
    this.closeEvent = null;

    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });

    this.socket.on('message', (raw) => this.#push(JSON.parse(raw.toString())));
    this.socket.on('close', (code, reason) => {
      this.closeEvent = { code, reason: reason.toString() };
      this.#push({ event: 'socket:closed', data: this.closeEvent });
    });
  }

  #push(frame) {
    this.#frames.push(frame);
    for (const waiter of [...this.#waiters]) {
      const match = this.#frames.find(waiter.predicate);
      if (match) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(match);
      }
    }
  }

  waitFor(event, { timeout = 5000, where } = {}) {
    const predicate = (frame) =>
      frame.event === event && (where ? where(frame.data ?? {}) : true);

    const existing = this.#frames.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `Timed out waiting for "${event}". Received: ${this.#frames
              .map((frame) => frame.event)
              .join(', ')}`,
          ),
        );
      }, timeout);
      this.#waiters.push(waiter);
    });
  }

  received(event) {
    return this.#frames.filter((frame) => frame.event === event);
  }

  send(event, data, requestId) {
    this.socket.send(JSON.stringify({ event, data, requestId }));
  }

  sendRaw(raw) {
    this.socket.send(raw);
  }

  /** Connect, authenticate, and resolve once the server confirms identity. */
  static async authenticated(url, token) {
    const client = new TestClient(url);
    await client.opened;
    await client.waitFor('connection:ready');
    client.send('auth:authenticate', { token });
    await client.waitFor('auth:authenticated');
    return client;
  }

  async close() {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
      await new Promise((resolve) => this.socket.once('close', resolve));
    }
  }
}
