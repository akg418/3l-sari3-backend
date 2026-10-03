import { BaseRepository, isDuplicateKeyError } from './BaseRepository.js';
import { Channel } from '../models/channel.model.js';
import { escapeRegExp } from '../utils/text.js';

export class ChannelRepository extends BaseRepository {
  constructor(model = Channel) {
    super(model);
  }

  async findById(id) {
    const channel = await this.model.findById(id).exec();
    return channel ? channel.toJSON() : null;
  }

  /** Includes the hashed channel password - only for the join flow. */
  async findByIdWithSecret(id) {
    const channel = await this.model.findById(id).select('+passwordHash').exec();
    if (!channel) return null;
    return { ...channel.toJSON(), passwordHash: channel.passwordHash };
  }

  async findActiveById(id, at = new Date()) {
    const channel = await this.model.findOne({ _id: id, expiresAt: { $gt: at } }).exec();
    return channel ? channel.toJSON() : null;
  }

  /**
   * The channel directory: live channels, newest first, optionally searched,
   * filtered and paged.
   *
   * Paging is keyset rather than offset. Channels disappear as they expire, so
   * an offset would silently skip entries between one page and the next; a
   * cursor stays correct however much the set shifts underneath it.
   */
  async listActive({ at = new Date(), ids, search, owner, type, limit, before } = {}) {
    const filter = { expiresAt: { $gt: at } };

    if (ids) filter._id = { $in: ids };
    if (type) filter.type = type;

    // `nameKey` is already lower-cased, so matching a lower-cased term is
    // case-insensitive without asking the engine for an insensitive scan.
    if (search) filter.nameKey = { $regex: escapeRegExp(search.trim().toLowerCase()) };
    if (owner) filter.createdByUsername = { $regex: escapeRegExp(owner.trim()), $options: 'i' };

    if (before?.createdAt) {
      const createdAt = new Date(before.createdAt);
      filter.$or = [
        { createdAt: { $lt: createdAt } },
        ...(before.id ? [{ createdAt, _id: { $lt: before.id } }] : []),
      ];
    }

    let query = this.model.find(filter).sort({ createdAt: -1, _id: -1 });
    if (limit) query = query.limit(limit);

    const channels = await query.exec();
    return channels.map((channel) => channel.toJSON());
  }

  existsByNameKey(nameKey) {
    return this.model.exists({ nameKey }).exec();
  }

  /** Case-insensitive lookup by the unique name key, used by name-based routes. */
  async findByNameKey(nameKey) {
    const channel = await this.model.findOne({ nameKey }).exec();
    return channel ? channel.toJSON() : null;
  }

  async findByNameKeyWithSecret(nameKey) {
    const channel = await this.model.findOne({ nameKey }).select('+passwordHash').exec();
    if (!channel) return null;
    return { ...channel.toJSON(), passwordHash: channel.passwordHash };
  }

  /**
   * How many channels this user owns, for the per-user cap.
   *
   * Counts rows that still exist rather than rows that are still live: a slot
   * is held by its channel until that channel is actually deleted, and the
   * count has to agree with the index that enforces it. The expiration job
   * closes the gap within a second.
   */
  countOwnedChannels(userId) {
    return this.model.countDocuments({ createdBy: userId }).exec();
  }

  /** Allowance slots currently held by this user's channels. */
  async listOccupiedSlots(userId) {
    const slots = await this.model
      .find({ createdBy: userId, ownerSlot: { $type: 'number' } })
      .select('ownerSlot')
      .lean()
      .exec();
    return slots.map((entry) => entry.ownerSlot);
  }

  isDuplicateOwnerSlot(error) {
    return isDuplicateKeyError(error, 'ownerSlot');
  }


  /** Channels whose lifetime has elapsed, oldest first, for the sweeper. */
  async findExpired({ at = new Date(), limit = 100 } = {}) {
    const channels = await this.model
      .find({ expiresAt: { $lte: at } })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .exec();
    return channels.map((channel) => channel.toJSON());
  }

  /**
   * Channels entering the warning window that have not been warned yet.
   * The claim below makes the warning fire exactly once, even with several
   * API instances sweeping concurrently.
   */
  async findPendingReminders({ at = new Date(), warningMs, limit = 100 } = {}) {
    const channels = await this.model
      .find({
        reminderSentAt: null,
        expiresAt: { $gt: at, $lte: new Date(at.getTime() + warningMs) },
      })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .exec();
    return channels.map((channel) => channel.toJSON());
  }

  /** Atomically claims the right to send the reminder for this channel. */
  async claimReminder(channelId, at = new Date()) {
    const result = await this.model
      .updateOne({ _id: channelId, reminderSentAt: null }, { $set: { reminderSentAt: at } })
      .exec();
    return result.modifiedCount === 1;
  }

  /**
   * Adds `minutes` to a live channel's lifetime, if its owner still has an
   * extension left. One conditional update, so two racing clicks can never
   * spend more than the allowance. Re-arms the one-minute warning.
   */
  async extend({ channelId, ownerId, minutes, maxExtensions, at = new Date() }) {
    const channel = await this.model
      .findOneAndUpdate(
        {
          _id: channelId,
          createdBy: ownerId,
          expiresAt: { $gt: at },
          extensionCount: { $not: { $gte: maxExtensions } },
        },
        [
          {
            $set: {
              expiresAt: { $add: ['$expiresAt', minutes * 60_000] },
              durationMinutes: { $add: ['$durationMinutes', minutes] },
              extensionCount: { $add: [{ $ifNull: ['$extensionCount', 0] }, 1] },
              reminderSentAt: null,
            },
          },
        ],
        { new: true },
      )
      .exec();
    return channel ? channel.toJSON() : null;
  }

  async isBlocked(channelId, userId) {
    return Boolean(await this.model.exists({ _id: channelId, 'blockedUsers.userId': userId }).exec());
  }

  async listBlocked(channelId) {
    const channel = await this.model.findById(channelId).select('blockedUsers').lean().exec();
    return (channel?.blockedUsers ?? []).map((entry) => ({
      id: entry.userId,
      username: entry.username,
      blockedAt: entry.blockedAt,
    }));
  }

  /** Idempotent: blocking someone already blocked changes nothing. */
  async block(channelId, { userId, username, at = new Date() }) {
    await this.model
      .updateOne(
        { _id: channelId, 'blockedUsers.userId': { $ne: userId } },
        { $push: { blockedUsers: { userId, username, blockedAt: at } } },
      )
      .exec();
  }

  async unblock(channelId, userId) {
    const result = await this.model
      .updateOne({ _id: channelId }, { $pull: { blockedUsers: { userId } } })
      .exec();
    return result.modifiedCount === 1;
  }

  countActive(at = new Date()) {
    return this.model.countDocuments({ expiresAt: { $gt: at } }).exec();
  }

  isDuplicateName(error) {
    return isDuplicateKeyError(error, 'nameKey');
  }
}
