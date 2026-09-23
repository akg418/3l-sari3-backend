import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, fixtures, registerUser } from '../helpers/testApp.js';
import { MongoBlobStorage } from '../../src/services/storage/index.js';

/** The HTTP-only path a client uses when WebSockets are switched off. */
describe('Polling mode (no WebSocket)', () => {
  let harness;
  let api;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness();
    api = harness.api;
  });

  afterEach(clearTestDatabase);

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  const setup = async () => {
    const owner = await registerUser(api);
    const reader = await registerUser(api);
    const channel = (await createChannel(api, owner.token, { name: 'pollroom' })).body.data.channel;
    await api.post('/api/channels/pollroom/join').set('Authorization', reader.authHeader).expect(200);
    return { owner, reader, channel };
  };

  const send = (user, content) =>
    api
      .post('/api/channels/pollroom/messages')
      .set('Authorization', user.authHeader)
      .send({ content, clientMessageId: 'c-1' });

  it('sends a message over HTTP and echoes the correlation id', async () => {
    const { owner } = await setup();

    const response = await send(owner, 'hello').expect(201);

    expect(response.body.data.clientMessageId).toBe('c-1');
    expect(response.body.data.message).toMatchObject({ content: 'hello' });
  });

  it('rejects an empty message and a non-member', async () => {
    const { owner } = await setup();
    const outsider = await registerUser(api);

    await send(owner, '   ').expect(422);
    await send(outsider, 'hi').expect(403);
  });

  it('returns only messages newer than the cursor, oldest first', async () => {
    const { owner, reader } = await setup();
    const first = (await send(owner, 'one').expect(201)).body.data.message;
    await send(owner, 'two').expect(201);
    await send(owner, 'three').expect(201);

    const response = await api
      .get('/api/channels/pollroom/messages')
      .query({ afterCreatedAt: first.createdAt, afterId: first.id })
      .set('Authorization', reader.authHeader)
      .expect(200);

    expect(response.body.data.messages.map((m) => m.content)).toEqual(['two', 'three']);
    expect(response.body.data.pageInfo.hasMore).toBe(false);
  });

  it('marks a channel read over HTTP, clearing the unread count', async () => {
    const { owner, reader } = await setup();
    await send(owner, 'ping').expect(201);

    const unread = async () => {
      const response = await api.get('/api/channels/mine').set('Authorization', reader.authHeader);
      return response.body.data.channels.find((c) => c.name === 'pollroom').unreadCount;
    };

    expect(await unread()).toBe(1);
    await api.post('/api/channels/pollroom/read').set('Authorization', reader.authHeader).expect(200);
    expect(await unread()).toBe(0);
  });
});

describe('MongoBlobStorage', () => {
  beforeAll(setupTestDatabase);
  afterEach(clearTestDatabase);
  afterAll(teardownTestDatabase);

  const readAll = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  it('round-trips bytes and deletes by scope without touching disk', async () => {
    const storage = new MongoBlobStorage();
    const buffer = fixtures.png();

    await storage.save({ scope: 's1', key: 'k1', buffer });
    await storage.save({ scope: 's2', key: 'k2', buffer });

    expect(await storage.exists({ scope: 's1', key: 'k1' })).toBe(true);
    expect((await readAll(storage.createReadStream({ scope: 's1', key: 'k1' }))).equals(buffer)).toBe(true);
    expect((await storage.listScopes()).sort()).toEqual(['s1', 's2']);

    await storage.deleteScope('s1');
    expect(await storage.exists({ scope: 's1', key: 'k1' })).toBe(false);
    expect(await storage.exists({ scope: 's2', key: 'k2' })).toBe(true);
  });
});
