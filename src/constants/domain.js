export const CHANNEL_TYPES = Object.freeze({
  PUBLIC: 'public',
  PRIVATE: 'private',
});

export const CHANNEL_TYPE_VALUES = Object.freeze(Object.values(CHANNEL_TYPES));

/**
 * The message model is intentionally open-ended: adding IMAGE/FILE/AUDIO later
 * means adding a value here plus a content validator, not a schema migration.
 */
export const MESSAGE_TYPES = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
  AUDIO: 'audio',
  VIDEO: 'video',
  SYSTEM: 'system',
});

export const MESSAGE_TYPE_VALUES = Object.freeze(Object.values(MESSAGE_TYPES));

/** Message types a client is currently allowed to create. */
export const CLIENT_SENDABLE_MESSAGE_TYPES = Object.freeze([
  MESSAGE_TYPES.TEXT,
  MESSAGE_TYPES.IMAGE,
  MESSAGE_TYPES.FILE,
]);

/**
 * How an attachment is presented. `image` is rendered inline in the
 * transcript; `file` is offered as a download.
 */
export const ATTACHMENT_KINDS = Object.freeze({
  IMAGE: 'image',
  FILE: 'file',
});

export const LIMITS = Object.freeze({
  USERNAME_MIN: 3,
  USERNAME_MAX: 24,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 72, // bcrypt truncates beyond 72 bytes
  NAME_MIN: 1,
  NAME_MAX: 40,
  CHANNEL_NAME_MAX: 20,
  CHANNEL_PASSWORD_MIN: 8,
  CHANNEL_PASSWORD_MAX: 20,
  MESSAGE_MAX: 2000,
  MESSAGE_PAGE_SIZE: 50,
  MESSAGE_PAGE_SIZE_MAX: 100,
  CHANNEL_PAGE_SIZE: 24,
  CHANNEL_PAGE_SIZE_MAX: 60,
  CHANNEL_SEARCH_MAX: 64,
  ATTACHMENTS_PER_MESSAGE: 5,
  ORIGINAL_FILENAME_MAX: 180,
});

/**
 * How long expired documents linger before MongoDB's TTL monitor removes them.
 * The application sweeper normally deletes them within a second; TTL is the
 * safety net for when the application is not running.
 */
export const TTL_GRACE_SECONDS = 60;
