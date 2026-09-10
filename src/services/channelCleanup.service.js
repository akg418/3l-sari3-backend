import { logger } from '../config/logger.js';

/**
 * Deletes channels and everything they contain.
 *
 * This lives apart from ChannelService for two reasons: it is the only thing
 * that needs to reach into storage as well as the database, and keeping it
 * separate avoids a dependency cycle with the attachment service (which needs
 * ChannelService for authorisation).
 *
 * There is no soft delete anywhere in the system. When a channel goes, its
 * messages, memberships, attachment records and the stored bytes all go with it.
 */
export class ChannelCleanupService {
  constructor({
    channelRepository,
    messageRepository,
    membershipRepository,
    attachmentRepository,
    storage,
  }) {
    this.channelRepository = channelRepository;
    this.messageRepository = messageRepository;
    this.membershipRepository = membershipRepository;
    this.attachmentRepository = attachmentRepository;
    this.storage = storage;
  }

  async purgeChannel(channelId) {
    const [messages, memberships, attachments] = await Promise.all([
      this.messageRepository.deleteByChannelId(channelId),
      this.membershipRepository.deleteByChannelId(channelId),
      this.attachmentRepository.deleteByChannelId(channelId),
    ]);

    // Files are grouped per channel, so the bytes go in one directory removal.
    await this.storage.deleteScope(channelId);
    await this.channelRepository.deleteById(channelId);

    return {
      deletedMessages: messages.deletedCount ?? 0,
      deletedMemberships: memberships.deletedCount ?? 0,
      deletedAttachments: attachments.deletedCount ?? 0,
    };
  }

  /**
   * Removes uploads that were never sent - a file picked, uploaded, then
   * abandoned when the composer was cleared or the tab closed.
   */
  async sweepOrphanUploads({ olderThanMs = 60 * 60 * 1000, at = new Date() } = {}) {
    const cutoff = new Date(at.getTime() - olderThanMs);
    const orphans = await this.attachmentRepository.findUnclaimedBefore(cutoff);
    if (orphans.length === 0) return 0;

    for (const attachment of orphans) {
      await this.storage.delete({ scope: attachment.storageScope, key: attachment.storageKey });
      await this.attachmentRepository.deleteById(attachment.id);
    }

    logger.debug('Swept abandoned uploads', { count: orphans.length });
    return orphans.length;
  }

  /**
   * Reconciles storage with the database at startup.
   *
   * MongoDB's TTL indexes can remove a channel while the application is not
   * running, which leaves its files with no owner. Since files are grouped by
   * channel id, any directory without a matching channel is dead weight.
   */
  async reconcileStorage() {
    const scopes = await this.storage.listScopes();
    let removed = 0;

    for (const scope of scopes) {
      const channel = await this.channelRepository.findById(scope);
      if (channel) continue;
      await this.storage.deleteScope(scope);
      removed += 1;
    }

    if (removed > 0) logger.info('Removed orphaned attachment directories', { count: removed });
    return removed;
  }
}
