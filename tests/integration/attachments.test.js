import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, fixtures, registerUser } from '../helpers/testApp.js';
import { Attachment } from '../../src/models/attachment.model.js';
import { Message } from '../../src/models/message.model.js';
import { Channel } from '../../src/models/channel.model.js';
import { PATTERNS } from '../../src/validators/rules.js';
import { env } from '../../src/config/env.js';

describe('Attachments', () => {
  let harness;
  let api;
  let container;
  let author;
  let channel;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness();
    ({ api, container } = harness);
  });

  beforeEach(async () => {
    author = await registerUser(api);
    const created = await createChannel(api, author.token, { name: 'files', durationMinutes: 30 });
    channel = created.body.data.channel;
  });

  afterEach(async () => {
    await clearTestDatabase();
    // Stored files do not live in the database, so they need clearing too -
    // otherwise one test's uploads look like another test's orphans.
    harness.clearStorage();
  });

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  const upload = (buffer, { filename, contentType, token = author.token, ref } = {}) =>
    api
      .post(`/api/channels/${ref ?? channel.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename, contentType });

  const storedPath = (attachmentId, channelId = channel.id) =>
    path.join(harness.storageRoot, channelId, attachmentId);

  describe('uploading', () => {
    it('accepts an image from a member and describes it', async () => {
      const response = await upload(fixtures.png(), {
        filename: 'holiday.png',
        contentType: 'image/png',
      });

      expect(response.status).toBe(201);
      const { attachment } = response.body.data;
      expect(attachment.id).toMatch(PATTERNS.UUID);
      expect(attachment).toMatchObject({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'holiday.png',
        isImage: true,
      });
      expect(attachment.url).toBe(`/api/channels/${channel.id}/attachments/${attachment.id}`);
      expect(attachment.sizeBytes).toBeGreaterThan(0);
    });

    it('writes the bytes to storage, outside any served directory', async () => {
      const response = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const { attachment } = response.body.data;

      expect(fs.existsSync(storedPath(attachment.id))).toBe(true);
      // Named by a server-generated id, never by anything the client supplied.
      expect(fs.readdirSync(path.join(harness.storageRoot, channel.id))).toEqual([attachment.id]);
    });

    it('never exposes where the file is stored', async () => {
      const response = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toContain('storageKey');
      expect(serialized).not.toContain('storageScope');
      expect(serialized).not.toContain(harness.storageRoot);
    });

    it.each([
      ['a PDF', () => fixtures.pdf(), 'report.pdf', 'application/pdf', 'application/pdf'],
      ['plain text', () => fixtures.text(), 'notes.txt', 'text/plain', 'text/plain'],
      ['a zip archive', () => fixtures.zip(), 'bundle.zip', 'application/zip', 'application/zip'],
      ['a JPEG', () => fixtures.jpeg(), 'photo.jpg', 'image/jpeg', 'image/jpeg'],
    ])('accepts %s', async (_label, build, filename, contentType, expectedMime) => {
      const response = await upload(build(), { filename, contentType });

      expect(response.status).toBe(201);
      expect(response.body.data.attachment.mimeType).toBe(expectedMime);
    });

    it('classifies documents as files and images as images', async () => {
      const image = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const document = await upload(fixtures.pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });

      expect(image.body.data.attachment.kind).toBe('image');
      expect(document.body.data.attachment.kind).toBe('file');
    });

    describe('unsafe uploads', () => {
      it('rejects an executable renamed as an image', async () => {
        const response = await upload(fixtures.elf(), {
          filename: 'totally-a-photo.png',
          contentType: 'image/png',
        });

        expect(response.status).toBe(415);
        expect(response.body.error.code).toBe('ATTACHMENT_TYPE_UNSUPPORTED');
      });

      it.each([
        ['SVG, which can carry script', () => fixtures.svg(), 'x.svg', 'image/svg+xml'],
        ['SVG smuggled as a PNG', () => fixtures.svg(), 'x.png', 'image/png'],
        ['HTML', () => fixtures.html(), 'x.html', 'text/html'],
        ['JavaScript', () => Buffer.from('alert(1)'), 'x.js', 'text/javascript'],
      ])('rejects %s', async (_label, build, filename, contentType) => {
        const response = await upload(build(), { filename, contentType });
        expect(response.status).toBe(415);
      });

      it('stores nothing when a file is rejected', async () => {
        await upload(fixtures.elf(), { filename: 'bad.png', contentType: 'image/png' });

        expect(await Attachment.countDocuments({})).toBe(0);
        expect(fs.existsSync(path.join(harness.storageRoot, channel.id))).toBe(false);
      });

      it('rejects an image above the image size limit', async () => {
        const oversized = fixtures.png(env.uploads.maxImageBytes + 1024);

        const response = await upload(oversized, { filename: 'huge.png', contentType: 'image/png' });

        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe('ATTACHMENT_TOO_LARGE');
      });

      it('strips directory components from the supplied filename', async () => {
        const response = await upload(fixtures.png(), {
          filename: '../../../etc/passwd.png',
          contentType: 'image/png',
        });

        expect(response.status).toBe(201);
        expect(response.body.data.attachment.filename).toBe('passwd.png');
      });

      it('corrects a filename whose extension contradicts the real type', async () => {
        const response = await upload(fixtures.png(), {
          filename: 'sneaky.exe',
          contentType: 'image/png',
        });

        expect(response.body.data.attachment.filename).toBe('sneaky.exe.png');
      });
    });

    describe('authorisation', () => {
      it('refuses an upload from someone who has not joined', async () => {
        const outsider = await registerUser(api);

        const response = await upload(fixtures.png(), {
          filename: 'a.png',
          contentType: 'image/png',
          token: outsider.token,
        });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('CHANNEL_NOT_JOINED');
      });

      it('refuses an unauthenticated upload', async () => {
        const response = await api
          .post(`/api/channels/${channel.id}/attachments`)
          .attach('file', fixtures.png(), { filename: 'a.png', contentType: 'image/png' });

        expect(response.status).toBe(401);
      });

      it('refuses an upload to an expired channel', async () => {
        await Channel.updateOne({ _id: channel.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });

        const response = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('CHANNEL_EXPIRED');
      });
    });

    it('publishes the upload rules for the client to pre-filter with', async () => {
      const response = await api
        .get('/api/channels/upload-constraints')
        .set('Authorization', author.authHeader)
        .expect(200);

      expect(response.body.data.upload).toMatchObject({
        maxImageBytes: env.uploads.maxImageBytes,
        maxFileBytes: env.uploads.maxFileBytes,
        maxPerMessage: 5,
      });
      expect(response.body.data.upload.allowedMimeTypes).toContain('image/png');
      expect(response.body.data.upload.allowedMimeTypes).not.toContain('image/svg+xml');
    });
  });

  describe('sending an attachment', () => {
    const uploadImage = async (options) => {
      const response = await upload(fixtures.png(), {
        filename: 'shot.png',
        contentType: 'image/png',
        ...options,
      });
      expect(response.status).toBe(201);
      return response.body.data.attachment;
    };

    it('carries the attachment on the message', async () => {
      const attachment = await uploadImage();

      const message = await container.messageService.createMessage(
        { channelId: channel.id, content: 'look at this', attachmentIds: [attachment.id] },
        author.user,
      );

      expect(message.messageType).toBe('image');
      expect(message.content).toBe('look at this');
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toMatchObject({
        id: attachment.id,
        kind: 'image',
        filename: 'shot.png',
        isImage: true,
      });
    });

    it('allows an attachment with no caption', async () => {
      const attachment = await uploadImage();

      const message = await container.messageService.createMessage(
        { channelId: channel.id, attachmentIds: [attachment.id] },
        author.user,
      );

      expect(message.content).toBe('');
      expect(message.attachments).toHaveLength(1);
    });

    it('marks a mixed set of attachments as a file message', async () => {
      const image = await uploadImage();
      const documentResponse = await upload(fixtures.pdf(), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      });

      const message = await container.messageService.createMessage(
        {
          channelId: channel.id,
          attachmentIds: [image.id, documentResponse.body.data.attachment.id],
        },
        author.user,
      );

      expect(message.messageType).toBe('file');
      expect(message.attachments).toHaveLength(2);
    });

    it('binds the upload to the message that sent it', async () => {
      const attachment = await uploadImage();

      const message = await container.messageService.createMessage(
        { channelId: channel.id, attachmentIds: [attachment.id] },
        author.user,
      );

      expect((await Attachment.findById(attachment.id)).messageId).toBe(message.id);
    });

    it('refuses to send the same upload twice', async () => {
      const attachment = await uploadImage();
      await container.messageService.createMessage(
        { channelId: channel.id, attachmentIds: [attachment.id] },
        author.user,
      );

      await expect(
        container.messageService.createMessage(
          { channelId: channel.id, attachmentIds: [attachment.id] },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_ALREADY_USED' });

      expect(await Message.countDocuments({ channelId: channel.id })).toBe(1);
    });

    it('refuses to attach an upload belonging to someone else', async () => {
      const other = await registerUser(api);
      await api
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', other.authHeader)
        .send({})
        .expect(200);

      const theirs = await uploadImage({ token: other.token });

      await expect(
        container.messageService.createMessage(
          { channelId: channel.id, attachmentIds: [theirs.id] },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    });

    it('refuses to attach an upload from another channel', async () => {
      const second = await createChannel(api, author.token, { name: 'other-room' });
      const elsewhere = await uploadImage({ ref: second.body.data.channel.id });

      await expect(
        container.messageService.createMessage(
          { channelId: channel.id, attachmentIds: [elsewhere.id] },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    });

    it('refuses an unknown attachment id', async () => {
      await expect(
        container.messageService.createMessage(
          { channelId: channel.id, attachmentIds: ['3f8a1c62-0000-4000-8000-000000000000'] },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    });

    it('refuses more attachments than a message may carry', async () => {
      const ids = [];
      for (let index = 0; index < 6; index += 1) {
        ids.push((await uploadImage()).id);
      }

      await expect(
        container.messageService.createMessage(
          { channelId: channel.id, attachmentIds: ids },
          author.user,
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT_REACHED' });
    });

    it('keeps plain text messages working exactly as before', async () => {
      const message = await container.messageService.createMessage(
        { channelId: channel.id, content: 'just text' },
        author.user,
      );

      expect(message).toMatchObject({ messageType: 'text', content: 'just text' });
      expect(message.attachments).toEqual([]);
    });
  });

  describe('downloading', () => {
    let attachment;

    beforeEach(async () => {
      const response = await upload(fixtures.png(), {
        filename: 'photo.png',
        contentType: 'image/png',
      });
      attachment = response.body.data.attachment;
    });

    it('serves the bytes to a member', async () => {
      const response = await api
        .get(attachment.url.replace('/api', '/api'))
        .set('Authorization', author.authHeader)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      expect(Buffer.compare(response.body, fixtures.png())).toBe(0);
    });

    it('sends hardened headers', async () => {
      const response = await api
        .get(attachment.url)
        .set('Authorization', author.authHeader)
        .expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['cache-control']).toContain('private');
    });

    it('offers an image inline and a document as a download', async () => {
      const documentResponse = await upload(fixtures.pdf(), {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      });

      const image = await api.get(attachment.url).set('Authorization', author.authHeader);
      const document = await api
        .get(documentResponse.body.data.attachment.url)
        .set('Authorization', author.authHeader);

      expect(image.headers['content-disposition']).toContain('inline');
      expect(image.headers['content-disposition']).toContain('photo.png');
      expect(document.headers['content-disposition']).toContain('attachment');
      expect(document.headers['content-disposition']).toContain('report.pdf');
    });

    it('refuses a non-member', async () => {
      const outsider = await registerUser(api);

      const response = await api.get(attachment.url).set('Authorization', outsider.authHeader);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CHANNEL_NOT_JOINED');
    });

    it('refuses an unauthenticated request', async () => {
      await api.get(attachment.url).expect(401);
    });

    it('will not serve an attachment through a channel it does not belong to', async () => {
      const second = await createChannel(api, author.token, { name: 'unrelated' });

      // A member of the second channel asking it for the first channel's file.
      const response = await api
        .get(`/api/channels/${second.body.data.channel.id}/attachments/${attachment.id}`)
        .set('Authorization', author.authHeader);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('refuses once the channel has expired', async () => {
      await Channel.updateOne({ _id: channel.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });

      const response = await api.get(attachment.url).set('Authorization', author.authHeader);
      expect(response.status).toBe(404);
    });

    it('rejects an attachment id that is not a UUID', async () => {
      const response = await api
        .get(`/api/channels/${channel.id}/attachments/not-a-uuid`)
        .set('Authorization', author.authHeader);

      expect(response.status).toBe(422);
    });
  });

  describe('cleanup', () => {
    it('deletes attachment records and files when the channel expires', async () => {
      const uploaded = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const attachment = uploaded.body.data.attachment;
      await container.messageService.createMessage(
        { channelId: channel.id, attachmentIds: [attachment.id] },
        author.user,
      );

      expect(fs.existsSync(storedPath(attachment.id))).toBe(true);

      await Channel.updateOne({ _id: channel.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
      await container.channelExpirationJob.tick();

      expect(await Attachment.countDocuments({ channelId: channel.id })).toBe(0);
      expect(fs.existsSync(storedPath(attachment.id))).toBe(false);
      expect(fs.existsSync(path.join(harness.storageRoot, channel.id))).toBe(false);
    });

    it('sweeps uploads that were never sent', async () => {
      const uploaded = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const attachment = uploaded.body.data.attachment;

      // Backdate it past the grace period, as an abandoned composer would be.
      // `createdAt` is immutable through the model, so this goes via the driver.
      await Attachment.collection.updateOne(
        { _id: attachment.id },
        { $set: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
      );

      const swept = await container.channelCleanupService.sweepOrphanUploads();

      expect(swept).toBe(1);
      expect(await Attachment.findById(attachment.id)).toBeNull();
      expect(fs.existsSync(storedPath(attachment.id))).toBe(false);
    });

    it('leaves a sent attachment alone when sweeping orphans', async () => {
      const uploaded = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const attachment = uploaded.body.data.attachment;
      await container.messageService.createMessage(
        { channelId: channel.id, attachmentIds: [attachment.id] },
        author.user,
      );
      await Attachment.collection.updateOne(
        { _id: attachment.id },
        { $set: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
      );

      expect(await container.channelCleanupService.sweepOrphanUploads()).toBe(0);
      expect(fs.existsSync(storedPath(attachment.id))).toBe(true);
    });

    it('removes files whose channel vanished while the process was down', async () => {
      const uploaded = await upload(fixtures.png(), { filename: 'a.png', contentType: 'image/png' });
      const attachment = uploaded.body.data.attachment;

      // What a TTL deletion during downtime leaves behind: files, no channel.
      await Channel.deleteOne({ _id: channel.id });

      const removed = await container.channelCleanupService.reconcileStorage();

      expect(removed).toBe(1);
      expect(fs.existsSync(storedPath(attachment.id))).toBe(false);
    });
  });
});
