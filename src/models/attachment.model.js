import mongoose from 'mongoose';
import { uuidPrimaryKey } from './plugins/uuidPrimaryKey.js';
import { ATTACHMENT_KINDS, LIMITS, TTL_GRACE_SECONDS } from '../constants/domain.js';

/**
 * An uploaded file, tracked separately from the message that references it.
 *
 * Uploading and sending are two steps: the client uploads first (so it can
 * show a preview and real progress), then sends a message that references the
 * attachment ids. Until a message claims it, `messageId` is null - which is
 * also how an abandoned upload is recognised.
 */
const attachmentSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, ref: 'Channel' },
    uploaderId: { type: String, required: true, ref: 'User' },

    /** Set when a message claims this upload. Null means "not sent yet". */
    messageId: { type: String, default: null, ref: 'Message' },

    kind: { type: String, required: true, enum: Object.values(ATTACHMENT_KINDS) },
    /** The resolved type, decided from the bytes - never the client's claim. */
    mimeType: { type: String, required: true },
    /** Sanitised original name, for display and downloads only. */
    filename: { type: String, required: true, maxlength: LIMITS.ORIGINAL_FILENAME_MAX },
    sizeBytes: { type: Number, required: true, min: 0 },

    /** Where the bytes are, as understood by the storage driver. */
    storageScope: { type: String, required: true },
    storageKey: { type: String, required: true },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Mirrors the channel, so attachments cannot outlive it. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'attachments' },
);

attachmentSchema.plugin(uuidPrimaryKey, {
  hidden: ['expiresAt', 'storageScope', 'storageKey', 'uploaderId'],
});

attachmentSchema.index({ channelId: 1, createdAt: -1 }, { name: 'idx_attachment_channel' });
attachmentSchema.index({ messageId: 1 }, { name: 'idx_attachment_message' });
attachmentSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: TTL_GRACE_SECONDS, name: 'ttl_attachment_expires_at' },
);

export const Attachment = mongoose.model('Attachment', attachmentSchema);
