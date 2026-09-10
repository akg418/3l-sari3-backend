import mongoose from 'mongoose';
import { uuidPrimaryKey } from './plugins/uuidPrimaryKey.js';
import { uuidV7 } from '../utils/id.js';
import { MESSAGE_TYPES, MESSAGE_TYPE_VALUES, LIMITS, TTL_GRACE_SECONDS } from '../constants/domain.js';

/**
 * An immutable snapshot of an attachment, embedded in the message that carries
 * it, so rendering a transcript needs no second query.
 *
 * Note what is *not* here: no URL and no storage location. The download path is
 * derived by the serializer, which keeps how bytes are stored out of the data
 * model - and means a client cannot be handed a link that bypasses the
 * authorisation check. The canonical record lives in the `attachments`
 * collection.
 */
const attachmentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, ref: 'Channel' },
    senderId: { type: String, required: true, ref: 'User' },
    /** Snapshot of the sender's display name; channels are short-lived. */
    senderUsername: { type: String, required: true },

    messageType: {
      type: String,
      required: true,
      enum: MESSAGE_TYPE_VALUES,
      default: MESSAGE_TYPES.TEXT,
    },

    /** Text body for text messages; a caption for attachment messages. */
    content: { type: String, default: '', maxlength: LIMITS.MESSAGE_MAX },

    attachments: { type: [attachmentSchema], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Mirrors the channel's expiry so messages cannot outlive their channel. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'messages' },
);

// Time-ordered ids: they break `createdAt` ties in chronological order, which
// is what keeps a transcript and its keyset pagination correct when several
// messages land in the same millisecond.
messageSchema.plugin(uuidPrimaryKey, { hidden: ['expiresAt'], generator: uuidV7 });

// History reads and cursor pagination are always "newest first, per channel".
messageSchema.index({ channelId: 1, createdAt: -1, _id: -1 }, { name: 'idx_channel_created' });
messageSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: TTL_GRACE_SECONDS, name: 'ttl_message_expires_at' },
);

export const Message = mongoose.model('Message', messageSchema);
