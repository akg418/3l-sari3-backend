import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, registerUser } from '../helpers/testApp.js';
import { Channel } from '../../src/models/channel.model.js';

describe('Channel directory: search, filters and paging', () => {
  let harness;
  let api;
  let viewer;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness();
    api = harness.api;
  });

  beforeEach(async () => {
    viewer = await registerUser(api);
  });

  afterEach(clearTestDatabase);

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  /** Creates a channel directly, so the per-user cap does not limit fixtures. */
  const seed = async ({ name, type = 'public', ownerUsername = 'ada', createdAt }) => {
    const at = createdAt ?? new Date();
    return Channel.create({
      name,
      nameKey: name.toLowerCase(),
      type,
      passwordHash: type === 'private' ? 'hashed' : null,
      createdBy: `owner-${ownerUsername}`,
      createdByUsername: ownerUsername,
      durationMinutes: 30,
      createdAt: at,
      expiresAt: new Date(at.getTime() + 30 * 60_000),
    });
  };

  const list = (query = {}) =>
    api.get('/api/channels').query(query).set('Authorization', viewer.authHeader);

  const namesFrom = (response) => response.body.data.channels.map((channel) => channel.name);

  describe('search by channel name', () => {
    beforeEach(async () => {
      await seed({ name: 'general' });
      await seed({ name: 'general-dev' });
      await seed({ name: 'random' });
      await seed({ name: 'Gaming' });
    });

    it('matches anywhere in the name, case insensitively', async () => {
      const response = await list({ search: 'GENERAL' }).expect(200);
      expect(namesFrom(response).sort()).toEqual(['general', 'general-dev']);
    });

    it('matches a fragment from the middle', async () => {
      const response = await list({ search: 'and' }).expect(200);
      expect(namesFrom(response)).toEqual(['random']);
    });

    it('returns everything when no search is given', async () => {
      const response = await list().expect(200);
      expect(namesFrom(response)).toHaveLength(4);
    });

    it('returns an empty page rather than an error when nothing matches', async () => {
      const response = await list({ search: 'nothing-here' }).expect(200);
      expect(response.body.data.channels).toEqual([]);
      expect(response.body.data.pageInfo.hasMore).toBe(false);
    });

    it('treats the search term as literal text, not a pattern', async () => {
      // An unescaped ".*" would match every channel; escaped, it matches none.
      const wildcard = await list({ search: '.*' }).expect(200);
      expect(wildcard.body.data.channels).toEqual([]);

      await seed({ name: 'a.b' });
      const literal = await list({ search: 'a.b' }).expect(200);
      expect(namesFrom(literal)).toEqual(['a.b']);

      const notWildcard = await list({ search: 'a.' }).expect(200);
      expect(namesFrom(notWildcard)).toEqual(['a.b']);
    });

    it('rejects an over-long search term', async () => {
      const response = await list({ search: 'x'.repeat(65) });
      expect(response.status).toBe(422);
    });
  });

  describe('filter by owner', () => {
    beforeEach(async () => {
      await seed({ name: 'ada-one', ownerUsername: 'ada' });
      await seed({ name: 'ada-two', ownerUsername: 'ada' });
      await seed({ name: 'grace-one', ownerUsername: 'grace_h' });
    });

    it('returns only that owner\'s channels', async () => {
      const response = await list({ owner: 'ada' }).expect(200);
      expect(namesFrom(response).sort()).toEqual(['ada-one', 'ada-two']);
    });

    it('is case insensitive', async () => {
      const response = await list({ owner: 'GRACE_H' }).expect(200);
      expect(namesFrom(response)).toEqual(['grace-one']);
    });

    it('matches a partial username', async () => {
      const response = await list({ owner: 'grace' }).expect(200);
      expect(namesFrom(response)).toEqual(['grace-one']);
    });

    it('reports the owner on each entry so the UI can show it', async () => {
      const response = await list({ owner: 'ada' }).expect(200);
      expect(response.body.data.channels[0].createdBy.username).toBe('ada');
    });
  });

  describe('filter by visibility', () => {
    beforeEach(async () => {
      await seed({ name: 'open-one' });
      await seed({ name: 'open-two' });
      await seed({ name: 'locked-one', type: 'private' });
    });

    it('returns only public channels', async () => {
      const response = await list({ type: 'public' }).expect(200);
      expect(namesFrom(response).sort()).toEqual(['open-one', 'open-two']);
    });

    it('returns only private channels, still without their secrets', async () => {
      const response = await list({ type: 'private' }).expect(200);

      expect(namesFrom(response)).toEqual(['locked-one']);
      expect(response.body.data.channels[0].isPrivate).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('rejects a visibility that is not a channel type', async () => {
      const response = await list({ type: 'secret' });
      expect(response.status).toBe(422);
    });
  });

  describe('combining search and filters', () => {
    beforeEach(async () => {
      await seed({ name: 'ada-open', ownerUsername: 'ada' });
      await seed({ name: 'ada-locked', ownerUsername: 'ada', type: 'private' });
      await seed({ name: 'grace-open', ownerUsername: 'grace' });
    });

    it('applies every filter together', async () => {
      const response = await list({ search: 'ada', owner: 'ada', type: 'public' }).expect(200);
      expect(namesFrom(response)).toEqual(['ada-open']);
    });

    it('returns nothing when the filters cannot all be satisfied', async () => {
      const response = await list({ owner: 'grace', type: 'private' }).expect(200);
      expect(response.body.data.channels).toEqual([]);
    });
  });

  describe('paging', () => {
    beforeEach(async () => {
      // Distinct timestamps, so the expected order is unambiguous.
      const base = Date.now() - 60_000;
      for (let index = 0; index < 7; index += 1) {
        await seed({ name: `page-${index}`, createdAt: new Date(base + index * 1000) });
      }
    });

    it('returns newest first', async () => {
      const response = await list().expect(200);
      expect(namesFrom(response)).toEqual([
        'page-6', 'page-5', 'page-4', 'page-3', 'page-2', 'page-1', 'page-0',
      ]);
    });

    it('limits the page and offers a cursor', async () => {
      const response = await list({ limit: 3 }).expect(200);

      expect(namesFrom(response)).toEqual(['page-6', 'page-5', 'page-4']);
      expect(response.body.data.pageInfo.hasMore).toBe(true);
      expect(response.body.data.pageInfo.nextCursor).toMatchObject({ id: expect.any(String) });
    });

    it('walks the whole directory without repeating or skipping', async () => {
      const seen = [];
      let cursor = null;
      let guard = 0;

      do {
        const response = await list({
          limit: 3,
          ...(cursor ? { beforeCreatedAt: cursor.createdAt, beforeId: cursor.id } : {}),
        }).expect(200);

        seen.push(...namesFrom(response));
        cursor = response.body.data.pageInfo.nextCursor;
        guard += 1;
      } while (cursor && guard < 10);

      expect(seen).toEqual([
        'page-6', 'page-5', 'page-4', 'page-3', 'page-2', 'page-1', 'page-0',
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('reports the last page as final', async () => {
      const first = await list({ limit: 6 }).expect(200);
      const cursor = first.body.data.pageInfo.nextCursor;

      const last = await list({
        limit: 6,
        beforeCreatedAt: cursor.createdAt,
        beforeId: cursor.id,
      }).expect(200);

      expect(namesFrom(last)).toEqual(['page-0']);
      expect(last.body.data.pageInfo.hasMore).toBe(false);
      expect(last.body.data.pageInfo.nextCursor).toBeNull();
    });

    it('keeps the filters applied while paging', async () => {
      await seed({ name: 'other-owner', ownerUsername: 'zoe' });

      const response = await list({ owner: 'ada', limit: 3 }).expect(200);
      expect(namesFrom(response).every((name) => name.startsWith('page-'))).toBe(true);
    });

    it('caps an over-large page request', async () => {
      const response = await list({ limit: 500 });
      expect(response.status).toBe(422);
    });

    it('rejects a cursor id that is not a UUID', async () => {
      const response = await list({
        beforeCreatedAt: new Date().toISOString(),
        beforeId: 'not-a-uuid',
      });
      expect(response.status).toBe(422);
    });

    it('never pages in an expired channel', async () => {
      await Channel.updateOne({ nameKey: 'page-6' }, { $set: { expiresAt: new Date(Date.now() - 1) } });

      const response = await list().expect(200);
      expect(namesFrom(response)).not.toContain('page-6');
    });
  });

  it('still reports membership and ownership on a filtered page', async () => {
    const created = await api
      .post('/api/channels')
      .set('Authorization', viewer.authHeader)
      .send({ name: 'mine-here', type: 'public', durationMinutes: 30 })
      .expect(201);

    const response = await list({ search: 'mine-here' }).expect(200);
    const entry = response.body.data.channels.find(
      (channel) => channel.id === created.body.data.channel.id,
    );

    expect(entry).toMatchObject({ isMember: true, isOwner: true, memberCount: 1 });
  });

  it('requires authentication', async () => {
    await api.get('/api/channels').query({ search: 'general' }).expect(401);
  });
});
