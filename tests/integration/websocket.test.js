import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { registerUser } from '../helpers/testApp.js';
import { startTestServer, TestClient, waitUntil } from '../helpers/wsClient.js';
import { Channel } from '../../src/models/channel.model.js';
import { PATTERNS } from '../../src/validators/rules.js';

const PRIVATE_PASSWORD = 'sup3r-channel-pw';

describe('WebSocket layer', () => {
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

  /** Registers a user and returns them with an authenticated socket. */
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

  describe('authentication', () => {
    it('greets a new socket and asks it to authenticate', async () => {
      const client = new TestClient(server.wsUrl);
      clients.push(client);
      await client.opened;

      const ready = await client.waitFor('connection:ready');
      expect(ready.data.connectionId).toMatch(PATTERNS.UUID);
      expect(ready.data.authTimeoutMs).toBeGreaterThan(0);
    });

    it('accepts a valid access token', async () => {
      const user = await registerUser(api);
      const client = new TestClient(server.wsUrl);
      clients.push(client);
      await client.opened;

      client.send('auth:authenticate', { token: user.token }, 'req-1');
      const frame = await client.waitFor('auth:authenticated');

      expect(frame.requestId).toBe('req-1');
      expect(frame.data.user.id).toBe(user.user.id);
      expect(JSON.stringify(frame)).not.toContain('passwordHash');
    });

    it('rejects a forged token and closes the socket', async () => {
      const client = new TestClient(server.wsUrl);
      clients.push(client);
      await client.opened;

      client.send('auth:authenticate', { token: 'not.a.real.jwt' });

      const error = await client.waitFor('error');
      expect(error.data.code).toBe('TOKEN_INVALID');

      const closed = await client.waitFor('socket:closed');
      expect(closed.data.code).toBe(4401);
    });

    it('refuses any other event before authentication', async () => {
      const client = new TestClient(server.wsUrl);
      clients.push(client);
      await client.opened;

      client.send('channel:join', { channelId: '3f8a1c62-0000-4000-8000-000000000000' });

      const error = await client.waitFor('error');
      expect(error.data.code).toBe('WS_NOT_AUTHENTICATED');
    });

    it('answers an application ping', async () => {
      const { client } = await connectedUser();
      client.send('ping', {}, 'ping-1');

      const pong = await client.waitFor('pong');
      expect(pong.requestId).toBe('ping-1');
    });
  });

  describe('invalid frames', () => {
    it('rejects a frame that is not JSON', async () => {
      const { client } = await connectedUser();
      client.sendRaw('this is not json');

      const error = await client.waitFor('error');
      expect(error.data.code).toBe('WS_MALFORMED_FRAME');
    });

    it('rejects a frame with no event name', async () => {
      const { client } = await connectedUser();
      client.sendRaw(JSON.stringify({ data: { hello: true } }));

      const error = await client.waitFor('error');
      expect(error.data.code).toBe('WS_MALFORMED_FRAME');
    });

    it('rejects an unknown event', async () => {
      const { client } = await connectedUser();
      client.send('channel:selfdestruct', {});

      const error = await client.waitFor('error');
      expect(error.data.code).toBe('WS_UNKNOWN_EVENT');
    });

    it('validates the payload of a known event', async () => {
      const { client } = await connectedUser();
      client.send('channel:join', { channelId: 'not-a-uuid' });

      const error = await client.waitFor('error');
      expect(error.data.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('joining channels', () => {
    it('joins a public channel and returns its recent history', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-public' });

      await server.container.messageService.createMessage(
        { channelId: channel.id, content: 'earlier message' },
        owner.user,
      );

      const joiner = await connectedUser();
      joiner.client.send('channel:join', { channelId: channel.id }, 'join-1');

      const joined = await joiner.client.waitFor('channel:joined');
      expect(joined.requestId).toBe('join-1');
      expect(joined.data.channel.id).toBe(channel.id);
      expect(joined.data.messages.map((message) => message.content)).toEqual(['earlier message']);
    });

    it('refuses a private channel without the password', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, {
        name: 'ws-private',
        type: 'private',
        password: PRIVATE_PASSWORD,
      });

      const joiner = await connectedUser();
      joiner.client.send('channel:join', { channelId: channel.id });

      const error = await joiner.client.waitFor('error');
      expect(error.data.code).toBe('CHANNEL_PASSWORD_REQUIRED');
    });

    it('accepts a private channel with the correct password', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, {
        name: 'ws-private-ok',
        type: 'private',
        password: PRIVATE_PASSWORD,
      });

      const joiner = await connectedUser();
      joiner.client.send('channel:join', { channelId: channel.id, password: PRIVATE_PASSWORD });

      const joined = await joiner.client.waitFor('channel:joined');
      expect(joined.data.channel.isMember).toBe(true);
    });

    it('refuses to join an expired channel', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-stale' });
      await Channel.updateOne({ _id: channel.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });

      const joiner = await connectedUser();
      joiner.client.send('channel:join', { channelId: channel.id });

      const error = await joiner.client.waitFor('error');
      expect(error.data.code).toBe('CHANNEL_EXPIRED');
    });

    it('tells the room when someone new arrives', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-arrivals' });
      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      const joiner = await connectedUser();
      joiner.client.send('channel:join', { channelId: channel.id });
      await joiner.client.waitFor('channel:joined');

      const arrival = await owner.client.waitFor('channel:member_joined');
      expect(arrival.data.user.username).toBe(joiner.user.username);
    });

    it('announces a newly created channel to every connected client', async () => {
      const watcher = await connectedUser();
      const creator = await connectedUser();

      await createChannelOver(creator.token, { name: 'ws-announced' });

      const created = await watcher.client.waitFor('channel:created');
      expect(created.data.channel.name).toBe('ws-announced');
      expect(JSON.stringify(created)).not.toContain('passwordHash');
    });

    /**
     * A broadcast reaches everyone, so it must not carry an answer that is
     * specific to one person. Sending the creator's own `isMember: true` to the
     * whole lobby made every other client believe it had joined - the channel
     * appeared under their "My Channels" until a refresh corrected it.
     */
    it('does not tell other clients they belong to a channel they did not join', async () => {
      const watcher = await connectedUser();
      const creator = await connectedUser();

      await createChannelOver(creator.token, { name: 'ws-not-mine' });
      const created = await watcher.client.waitFor('channel:created');

      expect(created.data.channel.isMember).toBeUndefined();
      expect(created.data.channel.isOwner).toBeUndefined();
    });

    it('leaves a bystander\'s channel list alone when someone else creates one', async () => {
      const watcher = await connectedUser();
      const creator = await connectedUser();

      await createChannelOver(creator.token, { name: 'ws-bystander' });
      await watcher.client.waitFor('channel:created');

      // What the client would see after the refresh that "fixed" it before.
      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', watcher.authHeader)
        .expect(200);

      expect(mine.body.data.channels).toHaveLength(0);
    });

    it('still tells the creator it is theirs', async () => {
      const creator = await connectedUser();

      const channel = await createChannelOver(creator.token, { name: 'ws-is-mine' });

      expect(channel.isMember).toBe(true);
      expect(channel.isOwner).toBe(true);

      const mine = await api
        .get('/api/channels/mine')
        .set('Authorization', creator.authHeader)
        .expect(200);

      expect(mine.body.data.channels.map((entry) => entry.name)).toEqual(['ws-is-mine']);
    });
  });

  describe('messaging', () => {
    const joinedPair = async (channelName) => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: channelName });

      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      const guest = await connectedUser();
      guest.client.send('channel:join', { channelId: channel.id });
      await guest.client.waitFor('channel:joined');

      return { owner, guest, channel };
    };

    it('delivers a message to the other members in real time', async () => {
      const { owner, guest, channel } = await joinedPair('ws-chat');

      owner.client.send('message:send', { channelId: channel.id, content: 'Hello everyone' }, 'm-1');

      const delivered = await guest.client.waitFor('message:new');
      expect(delivered.data.message).toMatchObject({
        channelId: channel.id,
        content: 'Hello everyone',
        messageType: 'text',
      });
      expect(delivered.data.message.sender.username).toBe(owner.user.username);
      expect(delivered.data.message.id).toMatch(PATTERNS.UUID);
    });

    it('acknowledges the send with the client correlation id', async () => {
      const { owner, channel } = await joinedPair('ws-ack');

      owner.client.send(
        'message:send',
        { channelId: channel.id, content: 'ack me', clientMessageId: 'local-42' },
        'm-2',
      );

      const ack = await owner.client.waitFor('message:ack');
      expect(ack.requestId).toBe('m-2');
      expect(ack.data).toMatchObject({ channelId: channel.id, clientMessageId: 'local-42' });
      expect(ack.data.messageId).toMatch(PATTERNS.UUID);
    });

    it('refuses a message to a channel the sender never joined', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-outsider' });

      const outsider = await connectedUser();
      outsider.client.send('message:send', { channelId: channel.id, content: 'let me in' });

      const error = await outsider.client.waitFor('error');
      expect(error.data.code).toBe('CHANNEL_NOT_JOINED');
    });

    it('will not let a client post as another user', async () => {
      const { owner, guest, channel } = await joinedPair('ws-impostor');

      guest.client.send('message:send', {
        channelId: channel.id,
        content: 'pretending',
        senderId: owner.user.id,
        senderUsername: owner.user.username,
      });

      const delivered = await owner.client.waitFor('message:new');
      expect(delivered.data.message.sender.id).toBe(guest.user.id);
    });

    it('rejects an empty message', async () => {
      const { owner, channel } = await joinedPair('ws-empty');
      owner.client.send('message:send', { channelId: channel.id, content: '   ' });

      const error = await owner.client.waitFor('error');
      expect(error.data.code).toBe('VALIDATION_ERROR');
    });

    it('stops delivering to a client that left the channel', async () => {
      const { owner, guest, channel } = await joinedPair('ws-leaving');

      guest.client.send('channel:leave', { channelId: channel.id });
      await guest.client.waitFor('channel:left');

      owner.client.send('message:send', { channelId: channel.id, content: 'after you left' });
      await owner.client.waitFor('message:new');

      expect(guest.client.received('message:new')).toHaveLength(0);
    });
  });

  describe('expiry notifications', () => {
    const placeInTime = async (channelId, ms) => {
      await Channel.updateOne({ _id: channelId }, { $set: { expiresAt: new Date(Date.now() + ms) } });
    };

    it('warns the members one minute before deletion', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-warned' });
      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      await placeInTime(channel.id, 45_000);
      await server.container.channelExpirationJob.tick();

      const warning = await owner.client.waitFor('channel:expiring');
      expect(warning.data).toMatchObject({
        channelId: channel.id,
        message: 'This channel will be deleted in 1 minute.',
      });
    });

    it('warns only once, however often the sweeper runs', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-warned-once' });
      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      await placeInTime(channel.id, 30_000);
      for (let tick = 0; tick < 5; tick += 1) {
        await server.container.channelExpirationJob.tick();
      }
      await owner.client.waitFor('channel:expiring');

      expect(owner.client.received('channel:expiring')).toHaveLength(1);
    });

    it('notifies every connected client when a channel expires', async () => {
      const insider = await connectedUser();
      const bystander = await connectedUser();
      const channel = await createChannelOver(insider.token, { name: 'ws-expiring' });

      insider.client.send('channel:join', { channelId: channel.id });
      await insider.client.waitFor('channel:joined');

      await placeInTime(channel.id, -1);
      await server.container.channelExpirationJob.tick();

      const insiderNotice = await insider.client.waitFor('channel:expired');
      const bystanderNotice = await bystander.client.waitFor('channel:expired');

      expect(insiderNotice.data.channelId).toBe(channel.id);
      expect(bystanderNotice.data.channelId).toBe(channel.id);
      expect(insiderNotice.data.message).toContain('expired');
    });

    it('delivers the expiry notice exactly once per client', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-expire-once' });
      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      await placeInTime(channel.id, -1);
      await server.container.channelExpirationJob.tick();
      await owner.client.waitFor('channel:expired');

      expect(owner.client.received('channel:expired')).toHaveLength(1);
    });

    it('refuses further messages once the channel is gone', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-gone' });
      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      await placeInTime(channel.id, -1);
      await server.container.channelExpirationJob.tick();
      await owner.client.waitFor('channel:expired');

      owner.client.send('message:send', { channelId: channel.id, content: 'anyone there?' });

      const error = await owner.client.waitFor('error');
      expect(error.data.code).toBe('CHANNEL_NOT_FOUND');
    });
  });

  describe('reconnection', () => {
    it('restores a subscription when a client reconnects and re-joins', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-reconnect' });

      const guest = await registerUser(api);
      const first = await TestClient.authenticated(server.wsUrl, guest.token);
      first.send('channel:join', { channelId: channel.id });
      await first.waitFor('channel:joined');
      await first.close();

      // A fresh socket re-authenticates and re-joins; no password is needed the
      // second time because membership already exists server-side.
      const second = await TestClient.authenticated(server.wsUrl, guest.token);
      clients.push(second);
      second.send('channel:join', { channelId: channel.id });
      const rejoined = await second.waitFor('channel:joined');
      expect(rejoined.data.channel.id).toBe(channel.id);

      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');
      owner.client.send('message:send', { channelId: channel.id, content: 'welcome back' });

      const delivered = await second.waitFor('message:new');
      expect(delivered.data.message.content).toBe('welcome back');
    });

    it('does not deliver to a socket that has gone away', async () => {
      const owner = await connectedUser();
      const channel = await createChannelOver(owner.token, { name: 'ws-dropped' });
      owner.client.send('channel:join', { channelId: channel.id });
      await owner.client.waitFor('channel:joined');

      const guest = await registerUser(api);
      const dropped = await TestClient.authenticated(server.wsUrl, guest.token);
      dropped.send('channel:join', { channelId: channel.id });
      await dropped.waitFor('channel:joined');
      await dropped.close();

      // The server must release the room reference when the socket goes away.
      await waitUntil(() => server.realtime.rooms.size(`channel:${channel.id}`) === 1);
      expect(server.realtime.rooms.size(`channel:${channel.id}`)).toBe(1);
    });
  });
});
