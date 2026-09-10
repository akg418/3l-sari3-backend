import { BaseRepository } from './BaseRepository.js';
import { Attachment } from '../models/attachment.model.js';

export class AttachmentRepository extends BaseRepository {
  constructor(model = Attachment) {
    super(model);
  }

  async findById(id) {
    const attachment = await this.model.findById(id).exec();
    return attachment ? this.#withStorage(attachment) : null;
  }

  async findManyByIds(ids) {
    const attachments = await this.model.find({ _id: { $in: ids } }).exec();
    return attachments.map((attachment) => this.#withStorage(attachment));
  }

  /**
   * Claims uploads for a message, but only those still unclaimed and belonging
   * to this uploader and channel. The filter *is* the authorisation check: a
   * client cannot attach someone else's upload, reuse one already sent, or
   * smuggle a file in from another channel, however it crafts the request.
   */
  async claimForMessage({ ids, messageId, channelId, uploaderId }) {
    const result = await this.model
      .updateMany(
        { _id: { $in: ids }, channelId, uploaderId, messageId: null },
        { $set: { messageId } },
      )
      .exec();
    return result.modifiedCount;
  }

  /** Uploads that were never sent, for the orphan sweep. */
  async findUnclaimedBefore(cutoff, limit = 200) {
    const attachments = await this.model
      .find({ messageId: null, createdAt: { $lt: cutoff } })
      .limit(limit)
      .exec();
    return attachments.map((attachment) => this.#withStorage(attachment));
  }

  countByChannelId(channelId) {
    return this.model.countDocuments({ channelId }).exec();
  }

  deleteByChannelId(channelId) {
    return this.model.deleteMany({ channelId }).exec();
  }

  /** `toJSON` hides the storage location, which this layer still needs. */
  #withStorage(document) {
    return {
      ...document.toJSON(),
      uploaderId: document.uploaderId,
      storageScope: document.storageScope,
      storageKey: document.storageKey,
      expiresAt: document.expiresAt,
    };
  }
}
