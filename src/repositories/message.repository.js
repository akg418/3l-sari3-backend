import { BaseRepository } from './BaseRepository.js';
import { Message } from '../models/message.model.js';

export class MessageRepository extends BaseRepository {
  constructor(model = Message) {
    super(model);
  }

  /**
   * Newest-first page of a channel's history.
   * `before` is a keyset cursor (createdAt + id) so pagination stays correct
   * when several messages share a millisecond.
   */
  async listByChannel(channelId, { limit = 50, before } = {}) {
    const filter = { channelId };

    if (before?.createdAt) {
      const createdAt = new Date(before.createdAt);
      filter.$or = [
        { createdAt: { $lt: createdAt } },
        ...(before.id ? [{ createdAt, _id: { $lt: before.id } }] : []),
      ];
    }

    const messages = await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .exec();

    return messages.map((message) => message.toJSON());
  }

  /**
   * Oldest-first messages newer than a keyset cursor - what a polling client
   * asks for to catch up on whatever arrived since its last sync.
   */
  async listAfter(channelId, { limit = 50, after }) {
    const createdAt = new Date(after.createdAt);
    const filter = {
      channelId,
      $or: [
        { createdAt: { $gt: createdAt } },
        ...(after.id ? [{ createdAt, _id: { $gt: after.id } }] : []),
      ],
    };

    const messages = await this.model
      .find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .exec();

    return messages.map((message) => message.toJSON());
  }

  /**
   * Unread counts for a set of memberships, in one round trip.
   *
   * Each channel has its own cutoff, so the match is a union of per-channel
   * clauses rather than a single range - which still uses the
   * `{ channelId, createdAt }` index. A member's own messages never count.
   */
  async countUnreadByChannel({ memberships, userId }) {
    const clauses = memberships
      .map((membership) => ({
        channelId: membership.channelId,
        createdAt: { $gt: membership.lastReadAt ?? membership.joinedAt },
      }))
      .filter((clause) => clause.createdAt.$gt);

    if (clauses.length === 0) return new Map();

    const rows = await this.model
      .aggregate([
        { $match: { senderId: { $ne: userId }, $or: clauses } },
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
