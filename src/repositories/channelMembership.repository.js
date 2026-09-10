import { BaseRepository } from './BaseRepository.js';
import { ChannelMembership } from '../models/channelMembership.model.js';

export class ChannelMembershipRepository extends BaseRepository {
  constructor(model = ChannelMembership) {
    super(model);
  }

  /** Idempotent join: re-joining an already joined channel is not an error. */
  async join({ channelId, userId, expiresAt }) {
    const membership = await this.model
      .findOneAndUpdate(
        { channelId, userId },
        { $setOnInsert: { channelId, userId, expiresAt, joinedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return membership.toJSON();
  }

  async exists({ channelId, userId }) {
    return Boolean(await this.model.exists({ channelId, userId }).exec());
  }

  async leave({ channelId, userId }) {
    const result = await this.model.deleteOne({ channelId, userId }).exec();
    return result.deletedCount === 1;
  }

  async listChannelIdsByUser(userId) {
    const memberships = await this.model.find({ userId }).select('channelId').lean().exec();
    return memberships.map((membership) => membership.channelId);
  }

  /** Memberships with their read cutoffs, for computing unread counts. */
  async listByUser(userId) {
    const memberships = await this.model
      .find({ userId })
      .select('channelId joinedAt lastReadAt')
      .lean()
      .exec();

    return memberships.map((entry) => ({
      channelId: entry.channelId,
      joinedAt: entry.joinedAt,
      lastReadAt: entry.lastReadAt,
    }));
  }

  /**
   * Moves the read cutoff forward. It never moves backwards, so an
   * out-of-order or replayed acknowledgement cannot resurrect read messages.
   */
  async markRead({ channelId, userId, at = new Date() }) {
    const result = await this.model
      .updateOne(
        { channelId, userId, $or: [{ lastReadAt: null }, { lastReadAt: { $lt: at } }] },
        { $set: { lastReadAt: at } },
      )
      .exec();
    return result.modifiedCount === 1;
  }

  /** Full membership rows for a channel, for building the roster. */
  async listByChannel(channelId) {
    const memberships = await this.model
      .find({ channelId })
      .select('userId joinedAt')
      .sort({ joinedAt: 1 })
      .lean()
      .exec();
    return memberships.map((entry) => ({ userId: entry.userId, joinedAt: entry.joinedAt }));
  }

  async listUserIdsByChannel(channelId) {
    const memberships = await this.model.find({ channelId }).select('userId').lean().exec();
    return memberships.map((membership) => membership.userId);
  }

  /** Member counts for a set of channels in one round trip. */
  async countByChannelIds(channelIds) {
    if (channelIds.length === 0) return new Map();

    const rows = await this.model
      .aggregate([
        { $match: { channelId: { $in: channelIds } } },
        { $group: { _id: '$channelId', count: { $sum: 1 } } },
      ])
      .exec();

    return new Map(rows.map((row) => [row._id, row.count]));
  }

  deleteByChannelId(channelId) {
    return this.model.deleteMany({ channelId }).exec();
  }

  deleteByChannelIds(channelIds) {
    return this.model.deleteMany({ channelId: { $in: channelIds } }).exec();
  }
}
