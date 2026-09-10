import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { registerUser } from '../helpers/testApp.js';
import { startTestServer, TestClient, waitUntil } from '../helpers/wsClient.js';

describe('Channel members and presence', () => {
  let server;
  let api;
  let clients;

  beforeAll(async () => {
    await setupTestDatabase();
    server = await startTestServer();
    api = request(server.baseUrl);
  });

  beforeEach(() => {
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await clearTestDatabase();
  });

  afterAll(async () => {
    await server.close();
    await teardownTestDatabase();
  });

  const connectedUser = async () => {
    const user = await registerUser(api);
    const client = await TestClient.authenticated(server.wsUrl, user.token);
    clients.push(client);
    return { ...user, client };
  };

  const createChannelOver = (token, overrides = {}) =>
    api
      .post('/api/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'public', durationMinutes: 30, ...overrides })
      .expect(201)
      .then((response) => response.body.data.channel);

  /** Joins over the socket and returns the acknowledgement payload. */
  const joinOver = async (user, channelId, password) => {
    user.client.send('channel:join', { channelId, ...(password ? { password } : {}) });
    const frame = await user.client.waitFor('channel:joined');
    return frame.data;
  };

  describe('the roster on join', () => {
    it('lists the members, with the owner flagged and shown online', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'roster' });

      const joined = await joinOver(owner, channel.id);

      expect(joined.members).toHaveLength(1);
      expect(joined.members[0]).toMatchObject({
        id: owner.user.id,
        username: owner.user.username,
        isOwner: true,
        isOnline: true,
      });
      expect(joined.members[0].displayName).toBe('Test User');
    });

    it('shows everyone who has joined, online or not', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'mixed' });

      // A second person joins over REST only: a member, but not connected.
      const absent = await registerUser(api);
      await api
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', absent.authHeader)
        .send({})
        .expect(200);

      const joined = await joinOver(owner, channel.id);
      const byUsername = new Map(joined.members.map((member) => [member.username, member]));

      expect(joined.members).toHaveLength(2);
      expect(byUsername.get(owner.user.username).isOnline).toBe(true);
      expect(byUsername.get(absent.user.username).isOnline).toBe(false);
      expect(byUsername.get(absent.user.username).isOwner).toBe(false);
    });

    it('never leaks anything sensitive about a member', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, {
        name: 'private-roster',
        type: 'private',
        password: 'sup3r-channel-pw',
      });

      const joined = await joinOver(owner, channel.id);
      const serialized = JSON.stringify(joined.members);

      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('sup3r-channel-pw');
      expect(serialized).not.toContain('usernameKey');
    });
  });

  describe('live presence', () => {
    it('tells the room when someone comes online', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'arrivals' });
      await joinOver(owner, channel.id);

      const guest = await connectedUser();
      await joinOver(guest, channel.id);

      const presence = await owner.client.waitFor('channel:presence');
      expect(presence.data).toMatchObject({
        channelId: channel.id,
        isOnline: true,
        user: { id: guest.user.id, username: guest.user.username },
      });
    });

    it('tells the room when a socket disappears without leaving', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'departures' });
      await joinOver(owner, channel.id);

      const guest = await registerUser(api);
      const guestClient = await TestClient.authenticated(server.wsUrl, guest.token);
      guestClient.send('channel:join', { channelId: channel.id });
      await guestClient.waitFor('channel:joined');
      await owner.client.waitFor('channel:presence');

      // A closed tab, not a polite "channel:leave".
      await guestClient.close();

      const offline = await owner.client.waitFor('channel:presence', {
        where: (data) => data.isOnline === false,
      });
      expect(offline.data.user.id).toBe(guest.user.id);
    });

    it('keeps a member online while any of their sockets remains', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'two-tabs' });
      await joinOver(owner, channel.id);

      const guest = await registerUser(api);
      const firstTab = await TestClient.authenticated(server.wsUrl, guest.token);
      const secondTab = await TestClient.authenticated(server.wsUrl, guest.token);
      clients.push(firstTab, secondTab);

      firstTab.send('channel:join', { channelId: channel.id });
      await firstTab.waitFor('channel:joined');
      secondTab.send('channel:join', { channelId: channel.id });
      await secondTab.waitFor('channel:joined');

      // Exactly one "came online" for two sockets belonging to one person.
      await waitUntil(() => owner.client.received('channel:presence').length >= 1);
      expect(owner.client.received('channel:presence')).toHaveLength(1);

      await firstTab.close();
      // One tab closing must not report them as gone.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        owner.client.received('channel:presence').filter((frame) => frame.data.isOnline === false),
      ).toHaveLength(0);

      await secondTab.close();
      const offline = await owner.client.waitFor('channel:presence', {
        where: (data) => data.isOnline === false,
      });
      expect(offline.data.user.id).toBe(guest.user.id);
    });

    it('pushes a fresh roster when membership changes', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'roster-push' });
      await joinOver(owner, channel.id);

      const guest = await connectedUser();
      await joinOver(guest, channel.id);

      const snapshot = await owner.client.waitFor('channel:members');
      expect(snapshot.data.channelId).toBe(channel.id);
      expect(snapshot.data.members.map((member) => member.username).sort()).toEqual(
        [owner.user.username, guest.user.username].sort(),
      );
    });

    it('drops a member from the roster when they leave', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'roster-drop' });
      await joinOver(owner, channel.id);

      const guest = await connectedUser();
      await joinOver(guest, channel.id);
      await owner.client.waitFor('channel:members');

      guest.client.send('channel:leave', { channelId: channel.id });
      await guest.client.waitFor('channel:left');

      const snapshot = await owner.client.waitFor('channel:members', {
        where: (data) => data.members.length === 1,
      });
      expect(snapshot.data.members[0].username).toBe(owner.user.username);
    });
  });

  describe('GET /api/channels/:channelRef/members', () => {
    it('returns the roster to a member, by channel name', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'named-roster' });
      await joinOver(owner, channel.id);

      const response = await api
        .get('/api/channels/named-roster/members')
        .set('Authorization', owner.authHeader)
        .expect(200);

      expect(response.body.data.channelId).toBe(channel.id);
      expect(response.body.data.members[0]).toMatchObject({
        username: owner.user.username,
        isOwner: true,
        isOnline: true,
      });
    });

    it('refuses to show the roster to a non-member', async () => {
      const owner = await connectedUser();
      await createChannelOver(owner.token, { name: 'hidden-roster' });
      const outsider = await registerUser(api);

      const response = await api
        .get('/api/channels/hidden-roster/members')
        .set('Authorization', outsider.authHeader);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CHANNEL_NOT_JOINED');
    });

    it('requires authentication', async () => {
      const owner = await connectedUser();
      await createChannelOver(owner.token, { name: 'auth-roster' });

      await api.get('/api/channels/auth-roster/members').expect(401);
    });

    it('always keeps the owner on the roster, since they cannot leave', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'owner-stays' });

      const guest = await registerUser(api);
      await api
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', guest.authHeader)
        .send({})
        .expect(200);

      await api
        .post(`/api/channels/${channel.id}/leave`)
        .set('Authorization', owner.authHeader)
        .expect(403);

      const response = await api
        .get('/api/channels/owner-stays/members')
        .set('Authorization', guest.authHeader)
        .expect(200);

      expect(response.body.data.members).toHaveLength(2);
      expect(response.body.data.members.some((member) => member.isOwner)).toBe(true);
    });

    it('drops a guest from the roster when they leave', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'guest-left' });

      const guest = await registerUser(api);
      await api
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', guest.authHeader)
        .send({})
        .expect(200);
      await api
        .post(`/api/channels/${channel.id}/leave`)
        .set('Authorization', guest.authHeader)
        .expect(200);

      const response = await api
        .get('/api/channels/guest-left/members')
        .set('Authorization', owner.authHeader)
        .expect(200);

      expect(response.body.data.members).toHaveLength(1);
      expect(response.body.data.members[0].isOwner).toBe(true);
    });
  });
});
