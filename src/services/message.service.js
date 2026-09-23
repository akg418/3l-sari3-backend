import { CLIENT_SENDABLE_MESSAGE_TYPES, ATTACHMENT_KINDS, LIMITS, MESSAGE_TYPES } from '../constants/domain.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { DOMAIN_EVENTS } from '../utils/domainEvents.js';
import { AppError, validationError } from '../utils/AppError.js';
import { uuidV7 } from '../utils/id.js';
import { logger } from '../config/logger.js';
import { toPublicMessage, toPublicMessageList } from '../serializers/message.serializer.js';

/** Control characters that have no business in a chat message (tab and newline are kept). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Normalises a message body. The result is stored as plain text and escaped at
 * render time - message content is never interpreted as markup anywhere.
 */
const sanitizeText = (value) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

/**
 * The stored type is derived from what the message actually carries, never from
 * what the client declared. A client's `messageType` is only used to reject
 * types this version does not accept.
 */
const deriveMessageType = (attachments) => {
  if (attachments.length === 0) return MESSAGE_TYPES.TEXT;
  const allImages = attachments.every((entry) => entry.kind === ATTACHMENT_KINDS.IMAGE);
  return allImages ? MESSAGE_TYPES.IMAGE : MESSAGE_TYPES.FILE;
};

export class MessageService {
  constructor({ messageRepository, channelService, attachmentService, eventBus }) {
    this.messageRepository = messageRepository;
    this.channelService = channelService;
    this.attachmentService = attachmentService;
    this.eventBus = eventBus;
  }

  /**
   * Creating a message re-checks channel liveness and membership on the server
   * for every single send; the client's claim to be a member is never trusted.
   *
   * Text and attachments travel together: a message may be text only, an
   * attachment with no caption, or both.
   */
  async createMessage(
    { channelId, channelRef, content, messageType, attachmentIds = [], metadata },
    actor,
  ) {
    if (messageType && !CLIENT_SENDABLE_MESSAGE_TYPES.includes(messageType)) {
      throw new AppError(
        ERROR_CODES.MESSAGE_TYPE_UNSUPPORTED,
        `Messages of type "${messageType}" are not supported yet.`,
        { status: 422 },
      );
    }

    const channel = await this.channelService.assertMembership(channelRef ?? channelId, actor.id);
    const body = sanitizeText(content ?? '');

    if (body.length > LIMITS.MESSAGE_MAX) {
      throw validationError(
        [{ field: 'content', message: `A message cannot exceed ${LIMITS.MESSAGE_MAX} characters.` }],
        'That message is too long.',
      );
    }

    const attachments =
      attachmentIds.length > 0
        ? await this.attachmentService.prepareForMessage(
            { channelId: channel.id, attachmentIds },
            actor,
          )
        : [];

    // An attachment carries the message on its own, so a caption is optional -
    // but something has to be sent.
    if (body.length === 0 && attachments.length === 0) {
      throw validationError(
        [{ field: 'content', message: 'A message cannot be empty.' }],
        'A message cannot be empty.',
      );
    }

    if (attachments.length === 0 && messageType && messageType !== MESSAGE_TYPES.TEXT) {
      throw validationError(
        [{ field: 'attachmentIds', message: 'An attachment message must include an attachment.' }],
        'That message has no attachment to send.',
      );
    }

    // The id is generated up front so the uploads can be bound to it.
    const messageId = uuidV7();

    const message = await this.messageRepository.create({
      _id: messageId,
      channelId: channel.id,
      senderId: actor.id,
      senderUsername: actor.username,
      messageType: deriveMessageType(attachments),
      content: body,
      attachments,
      metadata: metadata ?? {},
      // Mirrored from the channel so a message can never outlive its channel.
      expiresAt: channel.expiresAt,
    });

    if (attachments.length > 0) {
      const claimed = await this.attachmentService.claimForMessage(
        { attachmentIds: attachments.map((entry) => entry.id), messageId, channelId: channel.id },
        actor,
      );

      // Someone claimed the same upload first (a double-submit, or a replayed
      // request). Withdraw the message rather than leave a half-owned one.
      if (claimed !== attachments.length) {
        await this.messageRepository.deleteById(messageId);
        logger.warn('Attachment claim lost a race; message withdrawn', { messageId });
        throw new AppError(
          ERROR_CODES.ATTACHMENT_ALREADY_USED,
          'That upload has already been sent.',
          { status: 409 },
        );
      }
    }

    const publicMessage = toPublicMessage(message);
    this.eventBus.emit(DOMAIN_EVENTS.MESSAGE_CREATED, { message: publicMessage, channel });
    return publicMessage;
  }

  /**
   * A page of history, newest-first internally and returned oldest-first.
   *
   * History is not filtered by when the reader joined: someone who joins a
   * channel sees the conversation that led up to their arrival.
   */
  async listHistory(
    { channelId, channelRef, limit = LIMITS.MESSAGE_PAGE_SIZE, before, after },
    actor,
  ) {
    const channel = await this.channelService.assertMembership(channelRef ?? channelId, actor.id);

    const pageSize = Math.min(limit, LIMITS.MESSAGE_PAGE_SIZE_MAX);

    // Catch-up mode: everything newer than the cursor, already oldest-first.
    if (after) {
      const newer = await this.messageRepository.listAfter(channel.id, {
        limit: pageSize + 1,
        after,
      });
      const hasMore = newer.length > pageSize;
      const page = hasMore ? newer.slice(0, pageSize) : newer;
      const newest = page.at(-1);

      return {
        messages: toPublicMessageList(page),
        pageInfo: {
          hasMore,
          nextCursor: hasMore && newest ? { createdAt: newest.createdAt, id: newest.id } : null,
        },
      };
    }

    const messages = await this.messageRepository.listByChannel(channel.id, {
      limit: pageSize + 1,
      before,
    });

    const hasMore = messages.length > pageSize;
    const page = hasMore ? messages.slice(0, pageSize) : messages;
    const oldest = page.at(-1);

    return {
      // Ascending order is what a chat transcript wants to render.
      messages: toPublicMessageList(page).reverse(),
      pageInfo: {
        hasMore,
        nextCursor: hasMore && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
      },
    };
  }
}
