import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, registerUser } from '../helpers/testApp.js';
import { Message } from '../../src/models/message.model.js';
import { ChannelMembership } from '../../src/models/channelMembership.model.js';

const PASSWORD = 'sup3r-channel-pw';

describe('Owner controls', () => {
  let harness;
  let api;
  let owner;
  let guest;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness();
    api = harness.api;
  });

  beforeEach(async () => {
    owner = await registerUser(api);
    guest = await registerUser(api);
  });

  afterEach(clearTestDatabase);

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  const as = (user) => ({
    post: (path, body = {}) =>
      api.post(`/api/channels${path}`).set('Authorization', user.authHeader).send(body),
    get: (path) => api.get(`/api/channels${path}`).set('Authorization', user.authHeader),
  });

  describe('extending a channel', () => {
    it('adds 10 minutes and moves messages and memberships along with it', async () => {
      const { body } = await createChannel(api, owner.token, { name: 'grow', durationMinutes: 5 });
      const channel = body.data.channel;
      await as(owner).post('/grow/messages', { content: 'hi' }).expect(201);

      const response = await as(owner).post('/grow/extend').expect(200);
      const extended = response.body.data.channel;

      expect(Date.parse(extended.expiresAt) - Date.parse(channel.expiresAt)).toBe(10 * 60_000);
      expect(extended.durationMinutes).toBe(15);
      expect(extended.extensionsUsed).toBe(1);
      expect(extended.extensionsRemaining).toBe(5);

      const message = await Message.findOne({ channelId: channel.id }).lean();
      const membership = await ChannelMembership.findOne({ channelId: channel.id }).lean();
      expect(message.expiresAt.toISOString()).toBe(extended.expiresAt);
      expect(membership.expiresAt.toISOString()).toBe(extended.expiresAt);
    });

    it('allows only 6 extensions', async () => {
      await createChannel(api, owner.token, { name: 'capped' });
      for (let i = 0; i < 6; i += 1) await as(owner).post('/capped/extend').expect(200);

      const response = await as(owner).post('/capped/extend').expect(409);
      expect(response.body.error.code).toBe('CHANNEL_EXTENSION_LIMIT_REACHED');
    });

    it('never spends more than the allowance under concurrent requests', async () => {
      await createChannel(api, owner.token, { name: 'racy' });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => as(owner).post('/racy/extend')),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(6);
      const { body } = await as(owner).get('/racy').expect(200);
      expect(body.data.channel.extensionsUsed).toBe(6);
    });

    it('is refused to anyone but the owner', async () => {
      await createChannel(api, owner.token, { name: 'notyours' });
      await as(guest).post('/notyours/join').expect(200);

      const response = await as(guest).post('/notyours/extend').expect(403);
      expect(response.body.error.code).toBe('CHANNEL_OWNER_ONLY');
    });
  });

  describe('blocking a user', () => {
    it('removes a member from a public channel and refuses their rejoin', async () => {
      await createChannel(api, owner.token, { name: 'pub' });
      await as(guest).post('/pub/join').expect(200);

      const response = await as(owner).post('/pub/block', { userId: guest.user.id }).expect(200);
      expect(response.body.data.blocked).toEqual([
        expect.objectContaining({ id: guest.user.id, username: guest.user.username }),
      ]);

      const send = await as(guest).post('/pub/messages', { content: 'still here?' }).expect(403);
      expect(send.body.error.code).toBe('CHANNEL_NOT_JOINED');

      const rejoin = await as(guest).post('/pub/join').expect(403);
      expect(rejoin.body.error.code).toBe('CHANNEL_USER_BLOCKED');
    });

    it('refuses a blocked user even with the right private password', async () => {
      await createChannel(api, owner.token, { name: 'priv', type: 'private', password: PASSWORD });
      await as(owner).post('/priv/block', { userId: guest.user.id }).expect(200);

      const response = await as(guest).post('/priv/join', { password: PASSWORD }).expect(403);
      expect(response.body.error.code).toBe('CHANNEL_USER_BLOCKED');
    });

    it('lets them back in after an unblock', async () => {
      await createChannel(api, owner.token, { name: 'forgive' });
      await as(owner).post('/forgive/block', { userId: guest.user.id }).expect(200);

      const response = await as(owner).post('/forgive/unblock', { userId: guest.user.id });
      expect(response.body.data.blocked).toEqual([]);
      await as(guest).post('/forgive/join').expect(200);
    });

    it('is owner only, and the owner cannot block themselves', async () => {
      await createChannel(api, owner.token, { name: 'mod' });
      await as(guest).post('/mod/join').expect(200);

      const byGuest = await as(guest).post('/mod/block', { userId: owner.user.id }).expect(403);
      expect(byGuest.body.error.code).toBe('CHANNEL_OWNER_ONLY');

      const self = await as(owner).post('/mod/block', { userId: owner.user.id }).expect(403);
      expect(self.body.error.code).toBe('CHANNEL_CANNOT_BLOCK_OWNER');

      await as(guest).get('/mod/blocked').expect(403);
      await as(owner).get('/mod/blocked').expect(200);
    });
  });
});

describe('Statistics', () => {
  const CODE = 'let-me-see-stats';
  let harness;
  let api;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness({ overrides: { statsConfig: { accessCode: CODE } } });
    api = harness.api;
  });

  afterEach(clearTestDatabase);

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  it('requires the access code', async () => {
    const missing = await api.get('/api/stats').expect(403);
    expect(missing.body.error.code).toBe('STATS_CODE_INVALID');
    await api.get('/api/stats').set('X-Stats-Code', 'wrong-code-x').expect(403);
  });

  it('keeps counting channels and messages after they are deleted', async () => {
    const owner = await registerUser(api);
    await registerUser(api);
    const { body } = await createChannel(api, owner.token, { name: 'gone' });
    await api
      .post('/api/channels/gone/messages')
      .set('Authorization', owner.authHeader)
      .send({ content: 'one' })
      .expect(201);

    await harness.container.channelCleanupService.purgeChannel(body.data.channel.id);

    const response = await api.get('/api/stats').set('X-Stats-Code', CODE).expect(200);
    expect(response.body.data.stats).toMatchObject({
      totalUsers: 2,
      totalChannelsCreated: 1,
      totalMessagesSent: 1,
      activeChannels: 0,
    });
  });

  it('is disabled when no access code is configured', async () => {
    const disabled = buildTestHarness({ overrides: { statsConfig: { accessCode: null } } });
    const response = await disabled.api.get('/api/stats').set('X-Stats-Code', CODE).expect(404);
    expect(response.body.error.code).toBe('STATS_DISABLED');
    disabled.cleanupStorage();
  });
});
