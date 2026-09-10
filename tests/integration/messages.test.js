import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, registerUser } from '../helpers/testApp.js';
import { Message } from '../../src/models/message.model.js';
import { Channel } from '../../src/models/channel.model.js';
import { DOMAIN_EVENTS } from '../../src/utils/domainEvents.js';
import { PATTERNS } from '../../src/validators/rules.js';

describe('Messages', () => {
  let api;
  let container;
  let eventBus;
  let author;
  let channelId;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ api, container, eventBus } = buildTestHarness());
  });

  beforeEach(async () => {
    author = await registerUser(api);
    const created = await createChannel(api, author.token, { name: 'talking', durationMinutes: 30 });
    channelId = created.body.data.channel.id;
  });

  afterEach(clearTestDatabase);
  afterAll(teardownTestDatabase);

  const send = (content, actor = author.user) =>
    container.messageService.createMessage({ channelId, content }, actor);

  describe('sending', () => {
    it('lets a member send a message and persists it with a UUID', async () => {
      const message = await send('Hello!');

      expect(message.id).toMatch(PATTERNS.UUID);
      expect(message).toMatchObject({
        channelId,
        messageType: 'text',
        content: 'Hello!',
        attachments: [],
        metadata: {},
      });
      expect(message.sender).toEqual({ id: author.user.id, username: author.user.username });

      const stored = await Message.findById(message.id);
      expect(stored).not.toBeNull();
      expect(stored.content).toBe('Hello!');
      expect(stored._id).toBe(message.id);
    });

    it('gives every message a distinct id', async () => {
      const first = await send('one');
      const second = await send('two');
      expect(first.id).not.toBe(second.id);
    });

    it('copies the channel expiry onto the message so it cannot outlive it', async () => {
      const message = await send('ephemeral');

      const channel = await Channel.findById(channelId);
      const stored = await Message.findById(message.id);

      expect(stored.expiresAt.toISOString()).toBe(channel.expiresAt.toISOString());
    });

    it('announces the message on the domain event bus for realtime fan-out', async () => {
      const seen = [];
      eventBus.on(DOMAIN_EVENTS.MESSAGE_CREATED, (payload) => seen.push(payload));

      await send('broadcast me');

      expect(seen).toHaveLength(1);
      expect(seen[0].message.content).toBe('broadcast me');
    });

    it('refuses a message from someone who has not joined the channel', async () => {
      const outsider = await registerUser(api);

      await expect(send('let me in', outsider.user)).rejects.toMatchObject({
        code: 'CHANNEL_NOT_JOINED',
        status: 403,
      });

      expect(await Message.countDocuments({ channelId })).toBe(0);
    });

    it('refuses a message to a channel that has expired', async () => {
      await Channel.updateOne({ _id: channelId }, { $set: { expiresAt: new Date(Date.now() - 1) } });

      await expect(send('too late')).rejects.toMatchObject({ code: 'CHANNEL_EXPIRED' });
    });

    it('refuses a message to a channel that does not exist', async () => {
      await expect(
        container.messageService.createMessage(
          { channelId: '3f8a1c62-0000-4000-8000-000000000000', content: 'hi' },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    });

    it.each([
      ['empty', ''],
      ['only whitespace', '    '],
      ['only newlines', '\n\n\n'],
    ])('refuses a message that is %s', async (_label, content) => {
      await expect(send(content)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('refuses a message longer than the limit', async () => {
      await expect(send('a'.repeat(2001))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('strips control characters but keeps newlines', async () => {
      const noisy = `line one${String.fromCharCode(0)}\nline two${String.fromCharCode(7)}`;
      const message = await send(noisy);
      expect(message.content).toBe('line one\nline two');
    });

    it('refuses a message type that is not supported yet', async () => {
      await expect(
        container.messageService.createMessage(
          { channelId, content: 'listen to this', messageType: 'audio' },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'MESSAGE_TYPE_UNSUPPORTED' });
    });

    it('refuses an attachment message that carries no attachment', async () => {
      await expect(
        container.messageService.createMessage(
          { channelId, content: 'look at this', messageType: 'image', attachmentIds: [] },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('records the sender from the authenticated actor, not from the payload', async () => {
      const impostor = await registerUser(api);
      await api
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', impostor.authHeader)
        .send({})
        .expect(200);

      const message = await container.messageService.createMessage(
        {
          channelId,
          content: 'who am I?',
          senderId: author.user.id,
          senderUsername: author.user.username,
        },
        impostor.user,
      );

      expect(message.sender.id).toBe(impostor.user.id);
    });
  });

  describe('GET /api/channels/:channelId/messages', () => {
    it('returns the transcript in chronological order for a member', async () => {
      await send('first');
      await send('second');
      await send('third');

      const response = await api
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', author.authHeader)
        .expect(200);

      expect(response.body.data.messages.map((message) => message.content)).toEqual([
        'first',
        'second',
        'third',
      ]);
      expect(response.body.data.pageInfo.hasMore).toBe(false);
    });

    it('refuses to show the transcript to a non-member', async () => {
      await send('members only');
      const outsider = await registerUser(api);

      const response = await api
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', outsider.authHeader)
        .expect(403);

      expect(response.body.error.code).toBe('CHANNEL_NOT_JOINED');
      expect(JSON.stringify(response.body)).not.toContain('members only');
    });

    it('requires authentication', async () => {
      await api.get(`/api/channels/${channelId}/messages`).expect(401);
    });

    it('pages backwards through history with a stable cursor', async () => {
      for (let index = 0; index < 5; index += 1) {
        await send(`message ${index}`);
      }

      const firstPage = await api
        .get(`/api/channels/${channelId}/messages`)
        .query({ limit: 2 })
        .set('Authorization', author.authHeader)
        .expect(200);

      expect(firstPage.body.data.messages.map((message) => message.content)).toEqual([
        'message 3',
        'message 4',
      ]);
      expect(firstPage.body.data.pageInfo.hasMore).toBe(true);

      const cursor = firstPage.body.data.pageInfo.nextCursor;
      const secondPage = await api
        .get(`/api/channels/${channelId}/messages`)
        .query({ limit: 2, beforeCreatedAt: cursor.createdAt, beforeId: cursor.id })
        .set('Authorization', author.authHeader)
        .expect(200);

      expect(secondPage.body.data.messages.map((message) => message.content)).toEqual([
        'message 1',
        'message 2',
      ]);
    });
  });
});
