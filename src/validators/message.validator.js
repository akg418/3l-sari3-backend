import { z } from 'zod';
import { CLIENT_SENDABLE_MESSAGE_TYPES, LIMITS, MESSAGE_TYPES } from '../constants/domain.js';
import { channelRefField, messageContentField, uuidField } from './rules.js';

const messageFields = {
  /** Optional once attachments are present, where it acts as a caption. */
  content: messageContentField.optional(),
  messageType: z.enum(CLIENT_SENDABLE_MESSAGE_TYPES).default(MESSAGE_TYPES.TEXT),
  /** Ids of uploads already accepted for this channel by this user. */
  attachmentIds: z
    .array(uuidField('attachment id'))
    .max(LIMITS.ATTACHMENTS_PER_MESSAGE, `At most ${LIMITS.ATTACHMENTS_PER_MESSAGE} attachments per message.`)
    .default([]),
  /**
   * Client-generated correlation id, echoed back on the acknowledgement so the
   * sender can reconcile an optimistic bubble with the stored message.
   */
  clientMessageId: z.string().trim().max(64).optional(),
};

const requireContent = (value, ctx) => {
  const hasText = Boolean(value.content && value.content.trim());
  if (!hasText && value.attachmentIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['content'],
      message: 'A message cannot be empty.',
    });
  }
};

export const sendMessagePayloadSchema = z
  .object({ channelId: uuidField('channel id'), ...messageFields })
  .superRefine(requireContent);

/** REST send: the channel comes from the path, not the body. */
export const sendMessageSchema = z.object({
  params: z.object({ channelRef: channelRefField }),
  body: z.object(messageFields).superRefine(requireContent),
});

export const listMessagesSchema = z.object({
  params: z.object({ channelRef: channelRefField }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(LIMITS.MESSAGE_PAGE_SIZE_MAX).optional(),
    beforeCreatedAt: z.string().datetime({ offset: true }).optional(),
    beforeId: uuidField('cursor').optional(),
    /** Catch-up cursor: return messages newer than this, oldest first. */
    afterCreatedAt: z.string().datetime({ offset: true }).optional(),
    afterId: uuidField('cursor').optional(),
  }),
});
