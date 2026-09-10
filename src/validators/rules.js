import { z } from 'zod';
import { env } from '../config/env.js';
import { CHANNEL_TYPE_VALUES, LIMITS } from '../constants/domain.js';
import { UUID_PATTERN } from '../utils/id.js';

/**
 * The authoritative field rules. The frontend mirrors these patterns for
 * instant feedback, but this file is what actually decides.
 */
export const PATTERNS = Object.freeze({
  // At least 3 characters, never starts with a digit, no whitespace.
  USERNAME: /^[A-Za-z_][A-Za-z0-9_.-]{2,23}$/,
  // Never starts with a digit, no whitespace, at most 20 characters.
  CHANNEL_NAME: /^[A-Za-z_][A-Za-z0-9_.-]{0,19}$/,
  UUID: UUID_PATTERN,
});

export const MESSAGES = Object.freeze({
  USERNAME:
    'Username must be at least 3 characters, cannot start with a number, cannot contain spaces, and may only use letters, numbers, "_", "." or "-".',
  CHANNEL_NAME:
    'Channel name cannot start with a number, cannot contain spaces, may only use letters, numbers, "_", "." or "-", and must be at most 20 characters.',
});

export const uuidField = (label = 'identifier') =>
  z.string().trim().regex(PATTERNS.UUID, `Invalid ${label}.`);

/**
 * How a channel is named in a URL: either its UUID or its unique name.
 *
 * Channel names are already restricted to characters that are safe in a path
 * segment - no spaces, no slashes, no percent-encoding needed - so the name can
 * be used verbatim as the public identifier.
 */
export const channelRefField = z
  .string({ required_error: 'A channel identifier is required.' })
  .trim()
  .min(1, 'A channel identifier is required.')
  .max(64, 'Invalid channel identifier.')
  .refine(
    (value) => PATTERNS.UUID.test(value) || PATTERNS.CHANNEL_NAME.test(value),
    'Invalid channel identifier.',
  );

export const usernameField = z
  .string({ required_error: 'Username is required.' })
  .trim()
  .min(LIMITS.USERNAME_MIN, 'Username must be at least 3 characters.')
  .max(LIMITS.USERNAME_MAX, `Username must be at most ${LIMITS.USERNAME_MAX} characters.`)
  .regex(PATTERNS.USERNAME, MESSAGES.USERNAME);

export const personNameField = (label) =>
  z
    .string({ required_error: `${label} is required.` })
    .trim()
    .min(LIMITS.NAME_MIN, `${label} is required.`)
    .max(LIMITS.NAME_MAX, `${label} must be at most ${LIMITS.NAME_MAX} characters.`);

export const accountPasswordField = z
  .string({ required_error: 'Password is required.' })
  .min(LIMITS.PASSWORD_MIN, `Password must be at least ${LIMITS.PASSWORD_MIN} characters.`)
  .max(LIMITS.PASSWORD_MAX, `Password must be at most ${LIMITS.PASSWORD_MAX} characters.`);

export const channelNameField = z
  .string()
  .trim()
  .max(LIMITS.CHANNEL_NAME_MAX, `Channel name must be at most ${LIMITS.CHANNEL_NAME_MAX} characters.`)
  .regex(PATTERNS.CHANNEL_NAME, MESSAGES.CHANNEL_NAME);

export const channelPasswordField = z
  .string()
  .min(LIMITS.CHANNEL_PASSWORD_MIN, `Channel password must be at least ${LIMITS.CHANNEL_PASSWORD_MIN} characters.`)
  .max(LIMITS.CHANNEL_PASSWORD_MAX, `Channel password must be at most ${LIMITS.CHANNEL_PASSWORD_MAX} characters.`);

export const channelTypeField = z.enum(CHANNEL_TYPE_VALUES, {
  errorMap: () => ({ message: 'Channel type must be either "public" or "private".' }),
});

export const durationMinutesField = z.coerce
  .number({ invalid_type_error: 'Duration must be a number of minutes.' })
  .int('Duration must be a whole number of minutes.')
  .min(env.channel.minDurationMinutes, `Duration must be at least ${env.channel.minDurationMinutes} minute.`)
  .max(env.channel.maxDurationMinutes, `Duration cannot exceed ${env.channel.maxDurationMinutes} minutes.`);

export const messageContentField = z
  .string({ required_error: 'A message cannot be empty.' })
  .min(1, 'A message cannot be empty.')
  .max(LIMITS.MESSAGE_MAX, `A message cannot exceed ${LIMITS.MESSAGE_MAX} characters.`);
