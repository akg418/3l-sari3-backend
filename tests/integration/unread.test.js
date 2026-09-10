import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { registerUser } from '../helpers/testApp.js';
import { startTestServer, TestClient, waitUntil } from '../helpers/wsClient.js';
import { ChannelMembership } from '../../src/models/channelMembership.model.js';

describe('Unread messages', () => {
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

  const createChannel = (token, name) =>
    api
      .post('/api/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, type: 'public', durationMinutes: 30 })
      .expect(201)
      .then((response) => response.body.data.channel);

  const joinOver = async (user, channelId) => {
    user.client.send('channel:join', { channelId });
    return (await user.client.waitFor('channel:joined')).data;
  };

  let sendCounter = 0;
  /** Sends and waits for that specific acknowledgement, not just any. */
  const say = async (user, channelId, content) => {
    sendCounter += 1;
    const clientMessageId = `local-${sendCounter}`;
    user.client.send('message:send', { channelId, content, clientMessageId });
    await user.client.waitFor('message:ack', {
      where: (data) => data.clientMessageId === clientMessageId,
    });
  };

  const unreadFor = async (user, channelId) => {
    const response = await api
      .get('/api/channels/mine')
      .set('Authorization', user.authHeader)
      .expect(200);
    return response.body.data.channels.find((channel) => channel.id === channelId)?.unreadCount;
  };

  /** A member who has joined but is not watching the channel. */
  const setupAwayMember = async (name) => {
    const author = await connectedUser();
    const channel = await createChannel(author.token, name);
    await joinOver(author, channel.id);

    const reader = await connectedUser();
    await api
      .post(`/api/channels/${channel.id}/join`)
      .set('Authorization', reader.authHeader)
      .send({})
      .expect(200);

    return { author, reader, channel };
  };

  describe('counting', () => {
    it('starts at zero for a channel with nothing new', async () => {
      const { reader, channel } = await setupAwayMember('quiet');
      expect(await unreadFor(reader, channel.id)).toBe(0);
    });

    it('counts messages that arrived while the reader was away', async () => {
      const { author, reader, channel } = await setupAwayMember('busy');

      await say(author, channel.id, 'one');
      await say(author, channel.id, 'two');
      await say(author, channel.id, 'three');

      expect(await unreadFor(reader, channel.id)).toBe(3);
    });

    it('never counts the reader\'s own messages', async () => {
      const { author, reader, channel } = await setupAwayMember('self');

      await joinOver(reader, channel.id);
      await say(reader, channel.id, 'mine');
      await say(author, channel.id, 'theirs');

      // Opening the channel marked it read, so only the later one counts.
      expect(await unreadFor(reader, channel.id)).toBe(1);
    });

    it('clears when the reader opens the channel', async () => {
      const { author, reader, channel } = await setupAwayMember('opened');

      await say(author, channel.id, 'unread');
      expect(await unreadFor(reader, channel.id)).toBe(1);

      await joinOver(reader, channel.id);

      expect(await unreadFor(reader, channel.id)).toBe(0);
    });

    it('counts again after the reader looks away', async () => {
      const { author, reader, channel } = await setupAwayMember('again');

      await joinOver(reader, channel.id);
      await say(author, channel.id, 'while watching');
      await say(author, channel.id, 'and another');

      // The reader is subscribed, so these are delivered, but the client is
      // what decides to acknowledge them - the server does not assume.
      expect(await unreadFor(reader, channel.id)).toBe(2);

      // Joining already produced a `channel:read`, so waiting for that event
      // again would match the stale one. Wait for the effect instead.
      reader.client.send('channel:read', { channelId: channel.id });
      await waitUntil(async () => (await unreadFor(reader, channel.id)) === 0);
    });

    it('counts per channel, not in aggregate', async () => {
      const author = await connectedUser();
      const first = await createChannel(author.token, 'room-a');
      const second = await createChannel(author.token, 'room-b');
      await joinOver(author, first.id);
      await joinOver(author, second.id);

      const reader = await connectedUser();
      for (const channel of [first, second]) {
        await api
          .post(`/api/channels/${channel.id}/join`)
          .set('Authorization', reader.authHeader)
          .send({})
          .expect(200);
      }

      await say(author, first.id, 'only here');

      expect(await unreadFor(reader, first.id)).toBe(1);
      expect(await unreadFor(reader, second.id)).toBe(0);
    });

    it('does not count anything from before the reader joined', async () => {
      const author = await connectedUser();
      const channel = await createChannel(author.token, 'backlog');
      await joinOver(author, channel.id);

      await say(author, channel.id, 'said before you arrived');
      await say(author, channel.id, 'and again');

      const reader = await connectedUser();
      await api
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', reader.authHeader)
        .send({})
        .expect(200);

      // The history is still readable - it is just not flagged as unread.
      expect(await unreadFor(reader, channel.id)).toBe(0);
    });

    it('never moves the read cutoff backwards', async () => {
      const { author, reader, channel } = await setupAwayMember('monotonic');

      await joinOver(reader, channel.id);
      const membership = await ChannelMembership.findOne({
        channelId: channel.id,
        userId: reader.user.id,
      });
      const readAt = membership.lastReadAt;

      await say(author, channel.id, 'newer');
      reader.client.send('channel:read', { channelId: channel.id });
      await waitUntil(async () => (await unreadFor(reader, channel.id)) === 0);

      // A replayed acknowledgement must not resurrect read messages.
      await server.container.membershipRepository.markRead({
        channelId: channel.id,
        userId: reader.user.id,
        at: new Date(readAt.getTime() - 60_000),
      });

      const after = await ChannelMembership.findOne({
        channelId: channel.id,
        userId: reader.user.id,
      });
      expect(after.lastReadAt.getTime()).toBeGreaterThanOrEqual(readAt.getTime());
    });
  });

  describe('live notification', () => {
    it('nudges a member who is not watching the channel', async () => {
      const { author, reader, channel } = await setupAwayMember('nudge');

      await say(author, channel.id, 'hello?');

      const activity = await reader.client.waitFor('channel:activity');
      expect(activity.data).toMatchObject({
        channelId: channel.id,
        sender: { username: author.user.username },
      });
    });

    it('carries no message content', async () => {
      const { author, reader, channel } = await setupAwayMember('discreet');

      await say(author, channel.id, 'a very secret sentence');
      const activity = await reader.client.waitFor('channel:activity');

      expect(JSON.stringify(activity)).not.toContain('a very secret sentence');
    });

    it('does not nudge someone who is watching - they get the message', async () => {
      const { author, reader, channel } = await setupAwayMember('watching');
      await joinOver(reader, channel.id);

      await say(author, channel.id, 'in view');
      await reader.client.waitFor('message:new');

      expect(reader.client.received('channel:activity')).toHaveLength(0);
    });

    it('does not nudge the sender about their own message', async () => {
      const { author, channel } = await setupAwayMember('sender');

      await say(author, channel.id, 'mine');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(author.client.received('channel:activity')).toHaveLength(0);
    });

    it('does not nudge someone who is not a member at all', async () => {
      const { author, channel } = await setupAwayMember('outsiders');
      const outsider = await connectedUser();

      await say(author, channel.id, 'members only');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(outsider.client.received('channel:activity')).toHaveLength(0);
    });

    it('tells the user\'s other sessions when one of them reads the channel', async () => {
      const { author, reader, channel } = await setupAwayMember('two-tabs');

      const secondTab = await TestClient.authenticated(server.wsUrl, reader.token);
      clients.push(secondTab);

      await say(author, channel.id, 'unread somewhere');
      await reader.client.waitFor('channel:activity');

      // One tab opens the channel; the other should clear its badge too.
      await joinOver(reader, channel.id);

      const read = await secondTab.waitFor('channel:read');
      expect(read.data.channelId).toBe(channel.id);
    });
  });

  describe('authorisation', () => {
    it('refuses to mark a channel read for a non-member', async () => {
      const { channel } = await setupAwayMember('closed');
      const outsider = await connectedUser();

      outsider.client.send('channel:read', { channelId: channel.id });

      const error = await outsider.client.waitFor('error');
      expect(error.data.code).toBe('CHANNEL_NOT_JOINED');
    });

    it('rejects a malformed channel id', async () => {
      const reader = await connectedUser();
      reader.client.send('channel:read', { channelId: 'not-a-uuid' });

      const error = await reader.client.waitFor('error');
      expect(error.data.code).toBe('VALIDATION_ERROR');
    });

    it('never reports another user\'s unread count', async () => {
      const { author, reader, channel } = await setupAwayMember('private-count');
      await say(author, channel.id, 'unread for the reader only');

      await waitUntil(async () => (await unreadFor(reader, channel.id)) === 1);
      expect(await unreadFor(author, channel.id)).toBe(0);
    });
  });
});
