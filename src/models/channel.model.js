import mongoose from 'mongoose';
import { uuidPrimaryKey } from './plugins/uuidPrimaryKey.js';
import { CHANNEL_TYPES, CHANNEL_TYPE_VALUES, LIMITS, TTL_GRACE_SECONDS } from '../constants/domain.js';

const channelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: LIMITS.CHANNEL_NAME_MAX },

    /** Lower-cased uniqueness key, see User.usernameKey. */
    nameKey: { type: String, required: true, lowercase: true, trim: true },

    type: { type: String, required: true, enum: CHANNEL_TYPE_VALUES, default: CHANNEL_TYPES.PUBLIC },

    /** Only present for private channels, and never selected by default. */
    passwordHash: { type: String, default: null, select: false },

    createdBy: { type: String, required: true, ref: 'User' },

    /**
     * Which of its owner's allowance slots this channel occupies, 1..N.
     *
     * The slot exists so the *database* can enforce the per-user cap, the way
     * it already enforces channel-name uniqueness. Counting in application
     * code cannot: concurrent creates all read the same total.
     */
    ownerSlot: { type: Number, min: 1 },
    /** Denormalised so channel listings do not need a join for a display name. */
    createdByUsername: { type: String, required: true },

    durationMinutes: { type: Number, required: true, min: 1 },
    expiresAt: { type: Date, required: true },

    /**
     * Set the moment the "1 minute remaining" warning is broadcast. It doubles
     * as the idempotency guard that keeps the warning from firing every tick.
     */
    reminderSentAt: { type: Date, default: null },

    /**
     * Declared explicitly rather than via `timestamps`, because the service
     * derives `expiresAt` from this exact instant. Letting mongoose stamp it
     * separately would make the stored lifetime a few milliseconds short of
     * the duration the user asked for.
     */
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false, collection: 'channels' },
);

channelSchema.plugin(uuidPrimaryKey, { hidden: ['passwordHash', 'nameKey', 'reminderSentAt'] });

// Database-level uniqueness: two concurrent create requests cannot both win.
channelSchema.index({ nameKey: 1 }, { unique: true, name: 'uniq_channel_name_key' });

/**
 * Doubles as (a) the ascending index the expiration sweeper scans and
 * (b) a TTL safety net that removes channels even if the app is not running.
 * The grace period keeps the sweeper - which also cascades messages and
 * memberships and emits the realtime events - the normal deletion path.
 */
channelSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: TTL_GRACE_SECONDS, name: 'ttl_channel_expires_at' },
);

/**
 * At most one live channel per owner per slot, so N slots means N channels -
 * an invariant no amount of concurrency can talk its way past.
 *
 * The partial filter keeps channels created before this field existed out of
 * the index, so adding it to a running system cannot fail on their behalf.
 */
channelSchema.index(
  { createdBy: 1, ownerSlot: 1 },
  {
    unique: true,
    name: 'uniq_owner_slot',
    partialFilterExpression: { ownerSlot: { $type: 'number' } },
  },
);

/** Supports the directory's "newest first" listing and its keyset cursor. */
channelSchema.index({ createdAt: -1, _id: -1 }, { name: 'idx_channel_created' });

channelSchema.virtual('isPrivate').get(function isPrivate() {
  return this.type === CHANNEL_TYPES.PRIVATE;
});

export const Channel = mongoose.model('Channel', channelSchema);
