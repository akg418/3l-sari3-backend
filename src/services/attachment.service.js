import path from 'node:path';
import { ATTACHMENT_KINDS, LIMITS } from '../constants/domain.js';
import {
  ALLOWED_ATTACHMENT_TYPES,
  ALLOWED_MIME_TYPES,
  IMAGE_MIME_TYPES,
  resolveAttachmentType,
} from '../constants/attachments.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { AppError, notFound, validationError } from '../utils/AppError.js';
import { uuid } from '../utils/id.js';
import { logger } from '../config/logger.js';
import { toPublicAttachment } from '../serializers/attachment.serializer.js';

/**
 * Makes a client-supplied filename safe to store and to echo back.
 *
 * The stored path never uses this - files are keyed by a server-generated UUID -
 * so this only has to be safe as *text*: no directory components, no control
 * characters, no leading dot, and bounded in length.
 */
const sanitizeFilename = (rawName, extension) => {
  const base = path.basename(String(rawName ?? '')).replace(/[\u0000-\u001F\u007F]/g, '');
  const cleaned = base
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, LIMITS.ORIGINAL_FILENAME_MAX);

  if (cleaned) {
    // Keep the extension honest: it must match the type we actually detected.
    const hasCorrectExtension = cleaned.toLowerCase().endsWith(`.${extension}`);
    return hasCorrectExtension ? cleaned : `${cleaned}.${extension}`;
  }
  return `attachment.${extension}`;
};

export class AttachmentService {
  constructor({ attachmentRepository, channelService, storage, config }) {
    this.attachmentRepository = attachmentRepository;
    this.channelService = channelService;
    this.storage = storage;
    this.config = config;
  }

  /**
   * Accepts one uploaded file for a channel.
   *
   * Uploading is separate from sending so the composer can show a preview and
   * real progress before the message exists. The upload is inert until a
   * message claims it, and it is only ever readable by channel members.
   */
  async upload({ channelRef, file }, actor) {
    const channel = await this.channelService.assertMembership(channelRef, actor.id);

    if (!file?.buffer?.length) {
      throw validationError([{ field: 'file', message: 'A file is required.' }], 'No file was uploaded.');
    }

    // What the client called it is a hint; the bytes decide.
    const resolved = resolveAttachmentType(file.buffer, file.mimetype);
    if (!resolved) {
      throw new AppError(
        ERROR_CODES.ATTACHMENT_TYPE_UNSUPPORTED,
        'That file type is not allowed. Images, PDFs, office documents, archives and plain text are supported.',
        { status: 415 },
      );
    }

    const limit =
      resolved.kind === ATTACHMENT_KINDS.IMAGE
        ? this.config.maxImageBytes
        : this.config.maxFileBytes;

    if (file.buffer.length > limit) {
      throw new AppError(
        ERROR_CODES.ATTACHMENT_TOO_LARGE,
        `${resolved.kind === ATTACHMENT_KINDS.IMAGE ? 'Images' : 'Files'} must be ${formatBytes(limit)} or smaller.`,
        { status: 413 },
      );
    }

    const attachmentId = uuid();
    const filename = sanitizeFilename(file.originalname, resolved.extension);

    // The record is written first so a failure to store bytes leaves nothing
    // dangling that a message could reference.
    const attachment = await this.attachmentRepository.create({
      _id: attachmentId,
      channelId: channel.id,
      uploaderId: actor.id,
      kind: resolved.kind,
      mimeType: resolved.mimeType,
      filename,
      sizeBytes: file.buffer.length,
      storageScope: channel.id,
      storageKey: attachmentId,
      metadata: {},
      expiresAt: channel.expiresAt,
    });

    try {
      await this.storage.save({ scope: channel.id, key: attachmentId, buffer: file.buffer });
    } catch (error) {
      await this.attachmentRepository.deleteById(attachmentId);
      logger.error('Failed to store attachment', { attachmentId, error: error.message });
      throw new AppError(ERROR_CODES.UPLOAD_FAILED, 'The upload could not be stored.', {
        status: 500,
      });
    }

    logger.debug('Attachment stored', {
      attachmentId,
      channelId: channel.id,
      kind: resolved.kind,
      sizeBytes: file.buffer.length,
    });

    return toPublicAttachment(attachment, { channelId: channel.id });
  }

  /**
   * Validates the attachments a message wants to carry, and returns the
   * snapshots to embed.
   *
   * Every ownership rule is re-checked here: the upload must belong to this
   * user, to this channel, and must not already be attached to a message.
   */
  async prepareForMessage({ channelId, attachmentIds }, actor) {
    if (attachmentIds.length > LIMITS.ATTACHMENTS_PER_MESSAGE) {
      throw new AppError(
        ERROR_CODES.ATTACHMENT_LIMIT_REACHED,
        `A message can carry at most ${LIMITS.ATTACHMENTS_PER_MESSAGE} attachments.`,
        { status: 422 },
      );
    }

    const unique = [...new Set(attachmentIds)];
    const attachments = await this.attachmentRepository.findManyByIds(unique);

    if (attachments.length !== unique.length) {
      throw notFound(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'One of those uploads could not be found.');
    }

    for (const attachment of attachments) {
      // Deliberately the same error for "not yours", "wrong channel" and
      // "missing": a caller probing ids learns nothing from the response.
      if (attachment.uploaderId !== actor.id || attachment.channelId !== channelId) {
        throw notFound(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'One of those uploads could not be found.');
      }
      if (attachment.messageId) {
        throw new AppError(
          ERROR_CODES.ATTACHMENT_ALREADY_USED,
          'That upload has already been sent.',
          { status: 409 },
        );
      }
    }

    // Order the snapshots the way the client listed them.
    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    return unique.map((id) => {
      const attachment = byId.get(id);
      return {
        id: attachment.id,
        kind: attachment.kind,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        metadata: attachment.metadata ?? {},
      };
    });
  }

  /**
   * The upload rules, published so the client can filter and warn before
   * spending a round trip. The server enforces them regardless.
   */
  describeConstraints() {
    return {
      maxImageBytes: this.config.maxImageBytes,
      maxFileBytes: this.config.maxFileBytes,
      maxPerMessage: LIMITS.ATTACHMENTS_PER_MESSAGE,
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      imageMimeTypes: IMAGE_MIME_TYPES,
    };
  }

  /** Binds uploads to the message that now carries them. */
  claimForMessage({ attachmentIds, messageId, channelId }, actor) {
    return this.attachmentRepository.claimForMessage({
      ids: attachmentIds,
      messageId,
      channelId,
      uploaderId: actor.id,
    });
  }

  /**
   * Opens an attachment for download.
   *
   * Membership is checked before anything else, and the attachment must belong
   * to the channel in the request - so a member of one channel cannot read a
   * file from another by guessing or replaying an id.
   */
  async openForDownload({ channelRef, attachmentId }, actor) {
    const channel = await this.channelService.assertMembership(channelRef, actor.id);
    const attachment = await this.attachmentRepository.findById(attachmentId);

    if (!attachment || attachment.channelId !== channel.id) {
      throw notFound(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'That attachment could not be found.');
    }

    const exists = await this.storage.exists({
      scope: attachment.storageScope,
      key: attachment.storageKey,
    });
    if (!exists) {
      throw notFound(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'That attachment is no longer available.');
    }

    return {
      attachment,
      /**
       * Only types from our own allowlist are ever declared, so a stored file
       * can never talk the browser into treating it as something executable.
       */
      contentType: ALLOWED_ATTACHMENT_TYPES[attachment.mimeType]
        ? attachment.mimeType
        : 'application/octet-stream',
      /** Images may render inline; everything else is a download, never a page. */
      inline: attachment.kind === ATTACHMENT_KINDS.IMAGE,
      stream: () =>
        this.storage.createReadStream({
          scope: attachment.storageScope,
          key: attachment.storageKey,
        }),
    };
  }
}

const formatBytes = (bytes) => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.round(bytes / 1024)} KB`;
};
