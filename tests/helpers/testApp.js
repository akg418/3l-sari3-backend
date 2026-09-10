import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { createDomainEventBus } from '../../src/utils/domainEvents.js';
import { LocalFileStorage } from '../../src/services/storage/index.js';

/**
 * Builds a real container and a real Express app per test file - the same
 * object graph production uses, only pointed at the test database and at a
 * throwaway storage directory, so uploads never touch the real one.
 */
export const buildTestHarness = ({ overrides } = {}) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ephemera-test-'));
  const storage = new LocalFileStorage({ directory: storageRoot });
  fs.mkdirSync(storageRoot, { recursive: true });

  const eventBus = createDomainEventBus();
  const container = createContainer({ eventBus, overrides: { storage, ...overrides } });
  const app = createApp(container);

  return {
    app,
    container,
    eventBus,
    storage,
    storageRoot,
    api: request(app),
    /** Empties the file store without removing the root, for use in afterEach. */
    clearStorage: () => {
      for (const entry of fs.readdirSync(storageRoot)) {
        fs.rmSync(path.join(storageRoot, entry), { recursive: true, force: true });
      }
    },
    cleanupStorage: () => fs.rmSync(storageRoot, { recursive: true, force: true }),
  };
};

/** Minimal but genuinely valid file bodies, so magic-byte checks see real data. */
export const fixtures = {
  png: (padding = 32) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(padding, 0x01),
    ]),
  jpeg: (padding = 32) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(padding, 0x02)]),
  pdf: () => Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(32, 0x03)]),
  text: (body = 'plain text attachment') => Buffer.from(body, 'utf8'),
  zip: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0x04)]),
  /** An ELF header - the classic "executable wearing an image name" case. */
  elf: () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32, 0x05)]),
  svg: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  html: () => Buffer.from('<!doctype html><script>alert(1)</script>'),
};

/** Records every domain event, so tests can assert on what was announced. */
export const recordEvents = (eventBus, events) => {
  const recorded = [];
  for (const event of events) {
    eventBus.on(event, (payload) => recorded.push({ event, payload }));
  }
  return recorded;
};

let counter = 0;
export const uniqueUsername = (prefix = 'user') => {
  counter += 1;
  return `${prefix}_${counter}${Math.random().toString(36).slice(2, 6)}`;
};

export const registerUser = async (api, overrides = {}) => {
  const payload = {
    firstName: 'Test',
    lastName: 'User',
    username: uniqueUsername(),
    password: 'sup3r-secret',
    // Explicit undefined must not blank out a default.
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };

  const response = await api.post('/api/auth/register').send(payload).expect(201);

  return {
    payload,
    user: response.body.data.user,
    token: response.body.data.token,
    authHeader: `Bearer ${response.body.data.token}`,
  };
};

export const createChannel = async (api, token, overrides = {}) => {
  const response = await api
    .post('/api/channels')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'public', durationMinutes: 30, ...overrides });

  return response;
};
