import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, recordEvents, registerUser } from '../helpers/testApp.js';
import { Channel } from '../../src/models/channel.model.js';
import { Message } from '../../src/models/message.model.js';
import { ChannelMembership } from '../../src/models/channelMembership.model.js';
import { DOMAIN_EVENTS } from '../../src/utils/domainEvents.js';

const MINUTE = 60_000;

describe('Channel expiration', () => {
  let api;
  let container;
  let eventBus;
  let job;
  let owner;
  let events;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ api, container, eventBus } = buildTestHarness());
    job = container.channelExpirationJob;
  });

  beforeEach(async () => {
    owner = await registerUser(api);
    events = recordEvents(eventBus, [
      DOMAIN_EVENTS.CHANNEL_EXPIRING,
      DOMAIN_EVENTS.CHANNEL_EXPIRED,
    ]);
  });

  afterEach(async () => {
    eventBus.removeAllListeners();
    await clearTestDatabase();
  });

  afterAll(teardownTestDatabase);

  /** Creates a channel and rewrites its expiry, to place it in time precisely. */
  const channelExpiringIn = async (ms, { name, messages = 0 } = {}) => {
    const created = await createChannel(api, owner.token, { name, durationMinutes: 10 });
    const channelId = created.body.data.channel.id;

    for (let index = 0; index < messages; index += 1) {
      await container.messageService.createMessage(
        { channelId, content: `message ${index}` },
        owner.user,
      );
    }

    const expiresAt = new Date(Date.now() + ms);
    await Channel.updateOne({ _id: channelId }, { $set: { expiresAt } });
    await Message.updateMany({ channelId }, { $set: { expiresAt } });

    return channelId;
  };

  const eventsOfType = (type) => events.filter((entry) => entry.event === type);

  describe('the one minute reminder', () => {
    it('is triggered when a channel drops into the final minute', async () => {
      const channelId = await channelExpiringIn(45_000, { name: 'warning-soon' });

      await job.tick();

      const warnings = eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRING);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].payload).toMatchObject({ channelId, channelName: 'warning-soon' });
      expect(warnings[0].payload.secondsRemaining).toBeLessThanOrEqual(60);
      expect(warnings[0].payload.secondsRemaining).toBeGreaterThan(0);
    });

    it('addresses the reminder to the channel members', async () => {
      const channelId = await channelExpiringIn(30_000);
      const joiner = await registerUser(api);
      await api
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', joiner.authHeader)
        .send({})
        .expect(200);

      await job.tick();

      const [warning] = eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRING);
      expect(warning.payload.memberIds.sort()).toEqual([owner.user.id, joiner.user.id].sort());
    });

    it('is not re-sent on later ticks', async () => {
      await channelExpiringIn(50_000);

      // Stands in for a second of the sweeper running at its usual cadence.
      for (let tick = 0; tick < 20; tick += 1) {
        await job.tick();
      }

      expect(eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRING)).toHaveLength(1);
    });

    it('records the reminder so a restarted process does not repeat it', async () => {
      const channelId = await channelExpiringIn(40_000);

      await job.tick();
      expect((await Channel.findById(channelId)).reminderSentAt).toBeInstanceOf(Date);
    });

    it('is not sent while a channel still has more than a minute left', async () => {
      await channelExpiringIn(5 * MINUTE);

      await job.tick();

      expect(eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRING)).toHaveLength(0);
    });

    it('is claimed exactly once when several instances sweep at the same time', async () => {
      await channelExpiringIn(30_000);

      await Promise.all([job.tick(), job.tick(), job.tick()]);
      // A second round proves the persisted flag, not just the in-process guard.
      await job.tick();

      expect(eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRING)).toHaveLength(1);
    });
  });

  describe('deletion', () => {
    it('deletes the channel, its messages and its memberships', async () => {
      const channelId = await channelExpiringIn(-1, { name: 'doomed', messages: 3 });

      expect(await Message.countDocuments({ channelId })).toBe(3);

      await job.tick();

      expect(await Channel.findById(channelId)).toBeNull();
      expect(await Message.countDocuments({ channelId })).toBe(0);
      expect(await ChannelMembership.countDocuments({ channelId })).toBe(0);
    });

    it('announces the expiry with the members who were inside', async () => {
      const channelId = await channelExpiringIn(-1, { name: 'announce-me', messages: 2 });

      await job.tick();

      const [expired] = eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRED);
      expect(expired.payload).toMatchObject({
        channelId,
        channelName: 'announce-me',
        deletedMessages: 2,
        deletedMemberships: 1,
      });
      expect(expired.payload.memberIds).toEqual([owner.user.id]);
    });

    it('deletes regardless of whether anyone is connected', async () => {
      // No sockets exist in this suite at all, which is exactly the point.
      const channelId = await channelExpiringIn(-1);

      await job.tick();

      expect(await Channel.findById(channelId)).toBeNull();
      expect(eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRED)).toHaveLength(1);
    });

    it('leaves live channels untouched', async () => {
      const doomed = await channelExpiringIn(-1, { name: 'gone' });
      const survivor = await channelExpiringIn(5 * MINUTE, { name: 'alive' });

      await job.tick();

      expect(await Channel.findById(doomed)).toBeNull();
      expect(await Channel.findById(survivor)).not.toBeNull();
    });

    it('removes an expired channel from every listing', async () => {
      const channelId = await channelExpiringIn(-1, { name: 'vanishing' });

      await job.tick();

      const all = await api.get('/api/channels').set('Authorization', owner.authHeader).expect(200);
      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', owner.authHeader)
        .expect(200);

      expect(all.body.data.channels.map((channel) => channel.id)).not.toContain(channelId);
      expect(mine.body.data.channels).toHaveLength(0);
    });

    it('announces each expiry once, even across repeated ticks', async () => {
      await channelExpiringIn(-1);

      await job.tick();
      await job.tick();

      expect(eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRED)).toHaveLength(1);
    });

    it('sweeps a backlog of channels in one tick', async () => {
      const ids = await Promise.all([
        channelExpiringIn(-1, { name: 'batch-a' }),
        channelExpiringIn(-2, { name: 'batch-b' }),
        channelExpiringIn(-3, { name: 'batch-c' }),
      ]);

      await job.tick();

      expect(eventsOfType(DOMAIN_EVENTS.CHANNEL_EXPIRED)).toHaveLength(3);
      expect(await Channel.countDocuments({ _id: { $in: ids } })).toBe(0);
    });
  });

  describe('the database as a safety net', () => {
    it('declares a TTL index on every collection that holds channel data', async () => {
      const collections = { Channel, Message, ChannelMembership };

      for (const [name, model] of Object.entries(collections)) {
        const indexes = await model.collection.indexes();
        const ttlIndex = indexes.find((index) => index.expireAfterSeconds !== undefined);

        expect(ttlIndex, `${name} should declare a TTL index`).toBeDefined();
        expect(ttlIndex.key).toHaveProperty('expiresAt');
      }
    });

    it('enforces channel name uniqueness with a unique index', async () => {
      const indexes = await Channel.collection.indexes();
      const unique = indexes.find((index) => index.name === 'uniq_channel_name_key');

      expect(unique).toBeDefined();
      expect(unique.unique).toBe(true);
    });
  });
});
