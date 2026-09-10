import { z } from 'zod';
import { CHANNEL_TYPES, LIMITS } from '../constants/domain.js';
import {
  channelNameField,
  channelPasswordField,
  channelRefField,
  channelTypeField,
  durationMinutesField,
  uuidField,
} from './rules.js';

/**
 * An empty or omitted name means "generate one for me", so the name field is
 * optional but still fully validated when present.
 */
export const createChannelPayloadSchema = z
  .object({
    name: z
      .union([channelNameField, z.literal('')])
      .optional()
      .transform((value) => (value ? value : undefined)),
    type: channelTypeField.default(CHANNEL_TYPES.PUBLIC),
    password: channelPasswordField.optional(),
    durationMinutes: durationMinutesField,
  })
  .superRefine((value, ctx) => {
    if (value.type === CHANNEL_TYPES.PRIVATE && !value.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'A private channel requires a password.',
      });
    }
    if (value.type === CHANNEL_TYPES.PUBLIC && value.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'A public channel cannot have a password.',
      });
    }
  });

export const joinChannelPayloadSchema = z.object({
  channelId: uuidField('channel id'),
  password: z.string().max(200).optional(),
});

export const createChannelSchema = z.object({ body: createChannelPayloadSchema });

/**
 * Directory query. Every field is optional; an absent filter means "no
 * restriction" rather than a default that would surprise the caller.
 */
export const listChannelsSchema = z.object({
  query: z.object({
    search: z.string().trim().max(LIMITS.CHANNEL_SEARCH_MAX).optional(),
    owner: z.string().trim().max(LIMITS.USERNAME_MAX).optional(),
    type: channelTypeField.optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.CHANNEL_PAGE_SIZE_MAX).optional(),
    beforeCreatedAt: z.string().datetime({ offset: true }).optional(),
    beforeId: uuidField('cursor').optional(),
  }),
});

/**
 * REST routes address a channel by name or id, so a shared link reads
 * `/channels/general` rather than exposing a UUID.
 */
export const channelRefParamSchema = z.object({
  params: z.object({ channelRef: channelRefField }),
});

export const joinChannelSchema = z.object({
  params: z.object({ channelRef: channelRefField }),
  body: z.object({ password: z.string().max(200).optional() }),
});

export const attachmentParamSchema = z.object({
  params: z.object({
    channelRef: channelRefField,
    attachmentId: uuidField('attachment id'),
  }),
});
