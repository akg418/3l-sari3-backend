import mongoose from 'mongoose';
import { uuidPrimaryKey } from './plugins/uuidPrimaryKey.js';
import { TTL_GRACE_SECONDS } from '../constants/domain.js';

/**
 * Membership lives in its own collection rather than as an array on Channel:
 * it keeps "my channels" and every authorisation check a single indexed
 * lookup, and leaves room for per-member state (roles, read receipts, mutes).
 */
const channelMembershipSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, ref: 'Channel' },
    userId: { type: String, required: true, ref: 'User' },
    joinedAt: { type: Date, required: true, default: () => new Date() },

    /**
     * When this member last had the channel open. Everything newer than this
     * from somebody else is unread. Null means they have not opened it since
     * joining, so `joinedAt` is used as the cutoff.
     */
    lastReadAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, collection: 'channel_memberships' },
);

channelMembershipSchema.plugin(uuidPrimaryKey, { hidden: ['expiresAt'] });

channelMembershipSchema.index(
  { channelId: 1, userId: 1 },
  { unique: true, name: 'uniq_channel_member' },
);
channelMembershipSchema.index({ userId: 1 }, { name: 'idx_member_user' });
channelMembershipSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: TTL_GRACE_SECONDS, name: 'ttl_membership_expires_at' },
);

export const ChannelMembership = mongoose.model('ChannelMembership', channelMembershipSchema);
