import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, registerUser } from '../helpers/testApp.js';
import { Channel } from '../../src/models/channel.model.js';
import { env } from '../../src/config/env.js';

const LIMIT = env.channel.maxActivePerUser;

describe('Active channel limit', () => {
  let harness;
  let api;
  let owner;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness();
    api = harness.api;
  });

  beforeEach(async () => {
    owner = await registerUser(api);
  });

  afterEach(clearTestDatabase);

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  // Channel names cap at 20 characters, so the suffix stays short.
  let nameCounter = 0;
  const uniqueName = (prefix) => {
    nameCounter += 1;
    return `${prefix}_${nameCounter}`.slice(0, 20);
  };

  const fillQuota = async (token, count = LIMIT) => {
    for (let index = 0; index < count; index += 1) {
      const response = await createChannel(api, token, { name: uniqueName('q') });
      expect(response.status).toBe(201);
    }
  };

  it('is configured to four channels', () => {
    expect(LIMIT).toBe(4);
  });

  it('is enforced by a unique index, not only by application code', async () => {
    // The guarantee rests on this index existing. Without it the cap is just
    // a count, and a count cannot survive concurrency.
    const indexes = await Channel.collection.indexes();
    const slotIndex = indexes.find((index) => index.name === 'uniq_owner_slot');

    expect(slotIndex).toBeDefined();
    expect(slotIndex.unique).toBe(true);
    expect(slotIndex.key).toMatchObject({ createdBy: 1, ownerSlot: 1 });
  });

  it('assigns each of a user\'s channels a distinct slot', async () => {
    await fillQuota(owner.token);

    const channels = await Channel.find({ createdBy: owner.user.id }).lean();
    const slots = channels.map((channel) => channel.ownerSlot).sort();

    expect(slots).toEqual([1, 2, 3, 4]);
  });

  it('reuses the slot freed by an expired channel', async () => {
    await fillQuota(owner.token);
    const victim = await Channel.findOne({ createdBy: owner.user.id, ownerSlot: 2 });
    await Channel.deleteOne({ _id: victim._id });

    const response = await createChannel(api, owner.token, { name: uniqueName('reuse') });

    expect(response.status).toBe(201);
    const replacement = await Channel.findById(response.body.data.channel.id);
    expect(replacement.ownerSlot).toBe(2);
  });

  it('allows exactly the limit and refuses the next one', async () => {
    await fillQuota(owner.token);

    const overflow = await createChannel(api, owner.token, { name: 'one-too-many' });

    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('CHANNEL_LIMIT_REACHED');
    expect(overflow.body.error.message).toContain(String(LIMIT));
  });

  it('does not persist the channel it refused', async () => {
    await fillQuota(owner.token);
    await createChannel(api, owner.token, { name: 'not-created' });

    expect(await Channel.countDocuments({ createdBy: owner.user.id })).toBe(LIMIT);
    expect(await Channel.findOne({ nameKey: 'not-created' })).toBeNull();
  });

  it('lets a full batch of concurrent creates through when there is room', async () => {
    // The regression that rank-based settlement fixes: with a plain re-count,
    // every racer sees the same over-limit total and they all withdraw.
    const results = await Promise.all(
      Array.from({ length: LIMIT }, (_, index) =>
        createChannel(api, owner.token, { name: uniqueName(`b${index}`) }),
      ),
    );

    expect(results.filter((response) => response.status === 201)).toHaveLength(LIMIT);
    expect(await Channel.countDocuments({ createdBy: owner.user.id })).toBe(LIMIT);
  });

  it('cannot be bypassed by concurrent requests', async () => {
    await fillQuota(owner.token, LIMIT - 1);

    // Four simultaneous creates against a single remaining slot: the count
    // check alone cannot settle this, so the post-insert re-check has to.
    const results = await Promise.all([
      createChannel(api, owner.token, { name: 'race-a' }),
      createChannel(api, owner.token, { name: 'race-b' }),
      createChannel(api, owner.token, { name: 'race-c' }),
      createChannel(api, owner.token, { name: 'race-d' }),
    ]);

    const created = results.filter((response) => response.status === 201);
    const refused = results.filter((response) => response.status === 409);

    // Exactly one slot was free, so exactly one wins - never zero, which a
    // plain re-count would produce whenever all the racers overlap.
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(3);
    expect(refused.every((r) => r.body.error.code === 'CHANNEL_LIMIT_REACHED')).toBe(true);
    expect(await Channel.countDocuments({ createdBy: owner.user.id })).toBe(LIMIT);
  });

  it('counts only the channels a user owns, not the ones they joined', async () => {
    const other = await registerUser(api);
    await fillQuota(other.token);

    // Joining all four of someone else's channels must not consume any of the
    // caller's own allowance.
    const directory = await api.get('/api/channels').set('Authorization', owner.authHeader);
    for (const channel of directory.body.data.channels) {
      await api
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', owner.authHeader)
        .send({})
        .expect(200);
    }

    const response = await createChannel(api, owner.token, { name: 'my-own' });
    expect(response.status).toBe(201);
  });

  it('frees a slot once an expired channel is actually deleted', async () => {
    await fillQuota(owner.token);
    expect((await createChannel(api, owner.token, { name: 'blocked' })).status).toBe(409);

    const oldest = await Channel.findOne({ createdBy: owner.user.id });
    await Channel.updateOne({ _id: oldest._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });

    // A channel holds its slot until it is gone, not merely until it is due -
    // the sweeper is what frees it, within a second in production.
    await harness.container.channelExpirationJob.tick();

    const response = await createChannel(api, owner.token, { name: 'now-allowed' });
    expect(response.status).toBe(201);
  });

  it('still counts a channel that is due but not yet swept', async () => {
    await fillQuota(owner.token);
    const oldest = await Channel.findOne({ createdBy: owner.user.id });
    await Channel.updateOne({ _id: oldest._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });

    // Deliberately no sweep: the quota must not promise a slot the unique
    // index would then refuse.
    const quota = await api.get('/api/channels/quota').set('Authorization', owner.authHeader);
    expect(quota.body.data.quota.canCreate).toBe(false);
    expect((await createChannel(api, owner.token, { name: 'too-soon' })).status).toBe(409);
  });

  it('reports the allowance so the client can warn in advance', async () => {
    const empty = await api.get('/api/channels/quota').set('Authorization', owner.authHeader);
    expect(empty.body.data.quota).toEqual({ used: 0, limit: LIMIT, remaining: LIMIT, canCreate: true });

    await fillQuota(owner.token);

    const full = await api.get('/api/channels/quota').set('Authorization', owner.authHeader);
    expect(full.body.data.quota).toEqual({ used: LIMIT, limit: LIMIT, remaining: 0, canCreate: false });
  });

  it('includes the allowance alongside My Channels', async () => {
    await fillQuota(owner.token, 2);

    const response = await api
      .get('/api/channels/mine')
      .set('Authorization', owner.authHeader)
      .expect(200);

    expect(response.body.data.quota).toMatchObject({ used: 2, remaining: LIMIT - 2 });
  });

  it('applies per user, not globally', async () => {
    const other = await registerUser(api);
    await fillQuota(owner.token);

    expect((await createChannel(api, owner.token, { name: 'mine-blocked' })).status).toBe(409);
    expect((await createChannel(api, other.token, { name: 'theirs-fine' })).status).toBe(201);
  });
});
