import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, registerUser } from '../helpers/testApp.js';
import { Channel } from '../../src/models/channel.model.js';
import { DOMAIN_EVENTS } from '../../src/utils/domainEvents.js';

const PRIVATE_PASSWORD = 'sup3r-channel-pw';

describe('Channels', () => {
  let api;
  let eventBus;
  let owner;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ api, eventBus } = buildTestHarness());
  });

  beforeEach(async () => {
    owner = await registerUser(api);
  });

  afterEach(clearTestDatabase);
  afterAll(teardownTestDatabase);

  describe('POST /api/channels', () => {
    it('creates a public channel with a UUID id and a server-calculated expiry', async () => {
      const before = Date.now();
      const response = await createChannel(api, owner.token, { name: 'general', durationMinutes: 30 });
      expect(response.status).toBe(201);

      const { channel } = response.body.data;
      expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(channel).toMatchObject({ name: 'general', type: 'public', isPrivate: false });
      expect(channel.createdBy).toEqual({ id: owner.user.id, username: owner.user.username });

      const lifetimeMs = new Date(channel.expiresAt) - new Date(channel.createdAt);
      expect(lifetimeMs).toBe(30 * 60_000);
      expect(new Date(channel.expiresAt).getTime()).toBeGreaterThan(before);
    });

    it('ignores any client-supplied expiry and derives it from the duration', async () => {
      const response = await createChannel(api, owner.token, {
        name: 'trusted',
        durationMinutes: 5,
        expiresAt: new Date(Date.now() + 999 * 60_000).toISOString(),
      });

      const { channel } = response.body.data;
      expect(new Date(channel.expiresAt) - new Date(channel.createdAt)).toBe(5 * 60_000);
    });

    it('creates a private channel and never exposes its password', async () => {
      const response = await createChannel(api, owner.token, {
        name: 'private-room',
        type: 'private',
        password: PRIVATE_PASSWORD,
        durationMinutes: 10,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.channel).toMatchObject({ type: 'private', isPrivate: true });
      expect(JSON.stringify(response.body)).not.toContain(PRIVATE_PASSWORD);

      const stored = await Channel.findById(response.body.data.channel.id).select('+passwordHash');
      expect(stored.passwordHash).toBeTypeOf('string');
      expect(stored.passwordHash).not.toBe(PRIVATE_PASSWORD);
    });

    it('generates a channel_XXXXXX name when none is supplied', async () => {
      const response = await createChannel(api, owner.token, { durationMinutes: 15 });
      expect(response.status).toBe(201);
      expect(response.body.data.channel.name).toMatch(/^channel_\d{6}$/);
    });

    it('adds the creator as a member straight away', async () => {
      const created = await createChannel(api, owner.token, { name: 'mine-already' });

      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', owner.authHeader)
        .expect(200);

      expect(mine.body.data.channels.map((channel) => channel.id)).toContain(
        created.body.data.channel.id,
      );
    });

    it('announces the new channel on the domain event bus', async () => {
      const seen = [];
      eventBus.on(DOMAIN_EVENTS.CHANNEL_CREATED, (payload) => seen.push(payload));

      await createChannel(api, owner.token, { name: 'announced' });

      expect(seen).toHaveLength(1);
      expect(seen[0].channel.name).toBe('announced');
    });

    it('rejects a duplicate channel name, case insensitively', async () => {
      await createChannel(api, owner.token, { name: 'gaming' });
      const response = await createChannel(api, owner.token, { name: 'GAMING' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CHANNEL_NAME_TAKEN');
    });

    it('enforces channel name uniqueness with a database index', async () => {
      const created = await createChannel(api, owner.token, { name: 'indexed' });
      const original = await Channel.findById(created.body.data.channel.id);

      // Bypasses every application-level check: only the index can stop this.
      await expect(
        Channel.create({
          name: 'Indexed',
          nameKey: 'indexed',
          type: 'public',
          createdBy: owner.user.id,
          createdByUsername: owner.user.username,
          durationMinutes: 10,
          expiresAt: original.expiresAt,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it.each([
      ['starts with a number', '123room'],
      ['contains a space', 'my room'],
      ['is longer than 20 characters', 'this-channel-name-is-too-long'],
      ['contains illegal characters', 'my#channel'],
    ])('rejects a channel name that %s', async (_label, name) => {
      const response = await createChannel(api, owner.token, { name });

      expect(response.status).toBe(422);
      expect(response.body.error.details.some((detail) => detail.field === 'name')).toBe(true);
    });

    it.each([
      ['general', 'plain'],
      ['gaming', 'plain'],
      ['room123', 'trailing digits'],
      ['my-channel', 'a dash'],
    ])('accepts the channel name "%s" (%s)', async (name) => {
      const response = await createChannel(api, owner.token, { name });
      expect(response.status).toBe(201);
    });

    it('requires a password for a private channel', async () => {
      const response = await createChannel(api, owner.token, { name: 'no-pw', type: 'private' });

      expect(response.status).toBe(422);
      expect(response.body.error.details.some((detail) => detail.field === 'password')).toBe(true);
    });

    it.each([
      ['too short', 'short12'],
      ['too long', 'a'.repeat(21)],
    ])('rejects a private channel password that is %s', async (_label, password) => {
      const response = await createChannel(api, owner.token, {
        name: 'bad-pw',
        type: 'private',
        password,
      });

      expect(response.status).toBe(422);
      expect(response.body.error.details.some((detail) => detail.field === 'password')).toBe(true);
    });

    it.each([
      ['zero', 0],
      ['negative', -5],
      ['over the 60 minute maximum', 61],
      ['fractional', 1.5],
      ['not a number', 'ten'],
    ])('rejects a duration that is %s', async (_label, durationMinutes) => {
      const response = await createChannel(api, owner.token, { name: 'bad-duration', durationMinutes });

      expect(response.status).toBe(422);
      expect(response.body.error.details.some((detail) => detail.field === 'durationMinutes')).toBe(true);
    });

    it('accepts the 60 minute maximum', async () => {
      const response = await createChannel(api, owner.token, { name: 'hour', durationMinutes: 60 });
      expect(response.status).toBe(201);
    });

    it('requires authentication', async () => {
      const response = await api
        .post('/api/channels')
        .send({ name: 'anon', type: 'public', durationMinutes: 10 })
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /api/channels', () => {
    it('lists live channels without leaking private channel secrets', async () => {
      await createChannel(api, owner.token, { name: 'open-room' });
      await createChannel(api, owner.token, {
        name: 'locked-room',
        type: 'private',
        password: PRIVATE_PASSWORD,
        durationMinutes: 20,
      });

      const response = await api
        .get('/api/channels')
        .set('Authorization', owner.authHeader)
        .expect(200);

      const names = response.body.data.channels.map((channel) => channel.name);
      expect(names).toEqual(expect.arrayContaining(['open-room', 'locked-room']));

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PRIVATE_PASSWORD);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('nameKey');

      const locked = response.body.data.channels.find((channel) => channel.name === 'locked-room');
      expect(locked).toMatchObject({ isPrivate: true, type: 'private' });
      expect(locked.password).toBeUndefined();
    });

    it('omits channels whose lifetime has elapsed', async () => {
      const created = await createChannel(api, owner.token, { name: 'ghost', durationMinutes: 1 });
      await Channel.updateOne(
        { _id: created.body.data.channel.id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );

      const response = await api
        .get('/api/channels')
        .set('Authorization', owner.authHeader)
        .expect(200);

      expect(response.body.data.channels.map((channel) => channel.name)).not.toContain('ghost');
    });

    it('reports whether the caller has joined each channel', async () => {
      const created = await createChannel(api, owner.token, { name: 'membership-flag' });
      const other = await registerUser(api);

      const response = await api
        .get('/api/channels')
        .set('Authorization', other.authHeader)
        .expect(200);

      const channel = response.body.data.channels.find(
        (entry) => entry.id === created.body.data.channel.id,
      );
      expect(channel.isMember).toBe(false);
      expect(channel.memberCount).toBe(1);
    });
  });

  describe('POST /api/channels/:channelId/join', () => {
    it('joins a public channel with no password', async () => {
      const created = await createChannel(api, owner.token, { name: 'public-join' });
      const joiner = await registerUser(api);

      const response = await api
        .post(`/api/channels/${created.body.data.channel.id}/join`)
        .set('Authorization', joiner.authHeader)
        .send({})
        .expect(200);

      expect(response.body.data.channel.isMember).toBe(true);
      expect(response.body.data.channel.memberCount).toBe(2);
    });

    it('joins a private channel with the correct password', async () => {
      const created = await createChannel(api, owner.token, {
        name: 'private-join',
        type: 'private',
        password: PRIVATE_PASSWORD,
        durationMinutes: 20,
      });
      const joiner = await registerUser(api);

      await api
        .post(`/api/channels/${created.body.data.channel.id}/join`)
        .set('Authorization', joiner.authHeader)
        .send({ password: PRIVATE_PASSWORD })
        .expect(200);
    });

    it('rejects a private channel join with the wrong password', async () => {
      const created = await createChannel(api, owner.token, {
        name: 'private-wrong',
        type: 'private',
        password: PRIVATE_PASSWORD,
        durationMinutes: 20,
      });
      const joiner = await registerUser(api);

      const response = await api
        .post(`/api/channels/${created.body.data.channel.id}/join`)
        .set('Authorization', joiner.authHeader)
        .send({ password: 'definitely-wrong' })
        .expect(403);

      expect(response.body.error.code).toBe('CHANNEL_PASSWORD_INVALID');
    });

    it('rejects a private channel join with no password at all', async () => {
      const created = await createChannel(api, owner.token, {
        name: 'private-none',
        type: 'private',
        password: PRIVATE_PASSWORD,
        durationMinutes: 20,
      });
      const joiner = await registerUser(api);

      const response = await api
        .post(`/api/channels/${created.body.data.channel.id}/join`)
        .set('Authorization', joiner.authHeader)
        .send({})
        .expect(403);

      expect(response.body.error.code).toBe('CHANNEL_PASSWORD_REQUIRED');
    });

    it('cannot join a channel whose lifetime has elapsed, even with a valid id', async () => {
      const created = await createChannel(api, owner.token, { name: 'stale', durationMinutes: 1 });
      const joiner = await registerUser(api);

      // Simulates a client acting on a directory it fetched a while ago.
      await Channel.updateOne(
        { _id: created.body.data.channel.id },
        { $set: { expiresAt: new Date(Date.now() - 1) } },
      );

      const response = await api
        .post(`/api/channels/${created.body.data.channel.id}/join`)
        .set('Authorization', joiner.authHeader)
        .send({})
        .expect(404);

      expect(response.body.error.code).toBe('CHANNEL_EXPIRED');
    });

    it('returns CHANNEL_NOT_FOUND for an unknown channel', async () => {
      const response = await api
        .post('/api/channels/3f8a1c62-0000-4000-8000-000000000000/join')
        .set('Authorization', owner.authHeader)
        .send({})
        .expect(404);

      expect(response.body.error.code).toBe('CHANNEL_NOT_FOUND');
    });

    it('treats a non-UUID reference as a channel name', async () => {
      // Channels are addressed by name as well as by id, so this is a lookup
      // that finds nothing rather than a malformed request.
      const response = await api
        .post('/api/channels/no-such-channel/join')
        .set('Authorization', owner.authHeader)
        .send({})
        .expect(404);

      expect(response.body.error.code).toBe('CHANNEL_NOT_FOUND');
    });

    it.each([
      ['contains a space', 'bad%20name'],
      ['starts with a number', '9channel'],
      ['is longer than a channel name may be', 'a'.repeat(40)],
    ])('rejects a channel reference that %s', async (_label, ref) => {
      const response = await api
        .post(`/api/channels/${ref}/join`)
        .set('Authorization', owner.authHeader)
        .send({});

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['a bare traversal', '../join'],
      ['an encoded traversal', '%2e%2e%2f%2e%2e/join'],
      ['a nested path', 'foo/bar/join'],
      ['an encoded separator', 'general%2Fjoin/join'],
    ])('never resolves a channel from %s', async (_label, path) => {
      const response = await api
        .post(`/api/channels/${path}`)
        .set('Authorization', owner.authHeader)
        .send({});

      // However it is rejected - unmatched route or failed validation - what
      // matters is that it is never treated as a channel reference.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.data).toBeUndefined();
      expect(response.body.success).toBe(false);
    });

    it('joins a public channel by its name instead of its id', async () => {
      await createChannel(api, owner.token, { name: 'by-name' });
      const joiner = await registerUser(api);

      const response = await api
        .post('/api/channels/by-name/join')
        .set('Authorization', joiner.authHeader)
        .send({})
        .expect(200);

      expect(response.body.data.channel.name).toBe('by-name');
    });

    it('resolves a channel name case insensitively', async () => {
      await createChannel(api, owner.token, { name: 'MixedName' });
      const joiner = await registerUser(api);

      const response = await api
        .post('/api/channels/mixedname/join')
        .set('Authorization', joiner.authHeader)
        .send({})
        .expect(200);

      expect(response.body.data.channel.name).toBe('MixedName');
    });

    it('is idempotent, and lets an existing member back in without the password', async () => {
      const created = await createChannel(api, owner.token, {
        name: 'rejoin',
        type: 'private',
        password: PRIVATE_PASSWORD,
        durationMinutes: 20,
      });
      const joiner = await registerUser(api);
      const url = `/api/channels/${created.body.data.channel.id}/join`;

      await api.post(url).set('Authorization', joiner.authHeader).send({ password: PRIVATE_PASSWORD }).expect(200);
      const second = await api.post(url).set('Authorization', joiner.authHeader).send({}).expect(200);

      expect(second.body.data.channel.memberCount).toBe(2);
    });
  });

  describe('POST /api/channels/:channelId/leave', () => {
    it('removes someone else\'s channel from the caller\'s channels', async () => {
      const created = await createChannel(api, owner.token, { name: 'leaving' });
      const channelId = created.body.data.channel.id;
      const guest = await registerUser(api);

      await api
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', guest.authHeader)
        .send({})
        .expect(200);
      await api
        .post(`/api/channels/${channelId}/leave`)
        .set('Authorization', guest.authHeader)
        .expect(200);

      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', guest.authHeader)
        .expect(200);

      expect(mine.body.data.channels.map((channel) => channel.id)).not.toContain(channelId);
    });

    it('refuses to let the creator leave their own channel', async () => {
      const created = await createChannel(api, owner.token, { name: 'still-mine' });
      const channelId = created.body.data.channel.id;

      const response = await api
        .post(`/api/channels/${channelId}/leave`)
        .set('Authorization', owner.authHeader);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CHANNEL_OWNER_CANNOT_LEAVE');

      // Still theirs, still listed, still a member.
      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', owner.authHeader)
        .expect(200);
      const entry = mine.body.data.channels.find((channel) => channel.id === channelId);
      expect(entry).toMatchObject({ isOwner: true, isMember: true });
    });

    it('lets everyone else leave that same channel', async () => {
      const created = await createChannel(api, owner.token, { name: 'guests-may-go' });
      const channelId = created.body.data.channel.id;
      const guest = await registerUser(api);

      await api
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', guest.authHeader)
        .send({})
        .expect(200);
      await api
        .post(`/api/channels/${channelId}/leave`)
        .set('Authorization', guest.authHeader)
        .expect(200);
    });

    it('shows a channel the caller created, because creating joins it', async () => {
      const created = await createChannel(api, owner.token, { name: 'auto-joined' });

      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', owner.authHeader)
        .expect(200);

      const entry = mine.body.data.channels.find(
        (channel) => channel.id === created.body.data.channel.id,
      );
      expect(entry).toMatchObject({ isMember: true, isOwner: true });
    });

    it('keeps the owner a member, so they never lose access to their channel', async () => {
      const created = await createChannel(api, owner.token, { name: 'always-mine' });
      const channelId = created.body.data.channel.id;

      await api
        .post(`/api/channels/${channelId}/leave`)
        .set('Authorization', owner.authHeader)
        .expect(403);

      await api
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', owner.authHeader)
        .expect(200);
    });
  });

  describe('GET /api/channels/mine', () => {
    it('returns only the channels the caller has joined', async () => {
      const mineChannel = await createChannel(api, owner.token, { name: 'joined-one' });
      const otherUser = await registerUser(api);
      await createChannel(api, otherUser.token, { name: 'someone-else' });

      const response = await api
        .get('/api/channels/mine')
        .set('Authorization', owner.authHeader)
        .expect(200);

      expect(response.body.data.channels.map((channel) => channel.name)).toEqual(['joined-one']);
      expect(response.body.data.channels[0].id).toBe(mineChannel.body.data.channel.id);
    });
  });
});
