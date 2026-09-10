import { DOMAIN_EVENTS } from '../utils/domainEvents.js';
import { logger } from '../config/logger.js';

/**
 * Server-side source of truth for channel lifetime.
 *
 * On every tick it does two things:
 *  1. claims and announces the "about to be deleted" warning for channels that
 *     have crossed into the warning window;
 *  2. hard-deletes channels whose lifetime has elapsed, together with their
 *     messages and memberships, and announces the expiry.
 *
 * Both steps are safe to run on several API instances at once: the warning is
 * claimed with an atomic update so it is announced exactly once, and deletion
 * is idempotent. MongoDB TTL indexes back this up when nothing is running.
 */
const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class ChannelExpirationJob {
  #timer = null;
  #ticking = false;
  #lastOrphanSweepAt = 0;

  constructor({ channelRepository, channelCleanupService, membershipRepository, eventBus, config }) {
    this.channelRepository = channelRepository;
    this.channelCleanupService = channelCleanupService;
    this.membershipRepository = membershipRepository;
    this.eventBus = eventBus;
    this.intervalMs = config.sweepIntervalMs;
    this.warningMs = config.expiryWarningSeconds * 1000;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.#timer.unref?.();
    logger.info('Channel expiration job started', {
      intervalMs: this.intervalMs,
      warningSeconds: this.warningMs / 1000,
    });
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    logger.info('Channel expiration job stopped');
  }

  /** One sweep. Exposed so tests can drive expiry deterministically. */
  async tick(at = new Date()) {
    if (this.#ticking) return { skipped: true };
    this.#ticking = true;
    try {
      // Warnings first: a channel that is expiring this very tick should not
      // receive a warning it can no longer act on.
      const warned = await this.#sendPendingReminders(at);
      const expired = await this.#purgeExpiredChannels(at);
      await this.#sweepOrphanUploads(at);
      return { warned, expired };
    } catch (error) {
      logger.error('Channel expiration tick failed', { error: error.message });
      return { warned: [], expired: [], error: error.message };
    } finally {
      this.#ticking = false;
    }
  }

  async #sendPendingReminders(at) {
    const channels = await this.channelRepository.findPendingReminders({
      at,
      warningMs: this.warningMs,
    });

    const warned = [];
    for (const channel of channels) {
      // Whichever instance wins the claim is the only one that announces it,
      // and the persisted flag stops it firing again on the next tick.
      const claimed = await this.channelRepository.claimReminder(channel.id, at);
      if (!claimed) continue;

      const secondsRemaining = Math.max(
        0,
        Math.round((new Date(channel.expiresAt).getTime() - at.getTime()) / 1000),
      );

      // Members are resolved here so the warning can be routed to the people
      // it concerns, including their sessions that are not currently open on
      // this channel. It runs once per channel, never once per tick.
      const memberIds = await this.membershipRepository.listUserIdsByChannel(channel.id);

      this.eventBus.emit(DOMAIN_EVENTS.CHANNEL_EXPIRING, {
        channelId: channel.id,
        channelName: channel.name,
        expiresAt: new Date(channel.expiresAt).toISOString(),
        secondsRemaining,
        memberIds,
      });
      warned.push(channel.id);
    }

    if (warned.length > 0) logger.debug('Channel expiry warnings sent', { channels: warned });
    return warned;
  }

  /**
   * Uploads that were never sent leak storage, so they are swept too - but on
   * a much slower cadence than the per-second expiry check, since an abandoned
   * upload is not urgent.
   */
  async #sweepOrphanUploads(at) {
    if (at.getTime() - this.#lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return;
    this.#lastOrphanSweepAt = at.getTime();
    await this.channelCleanupService.sweepOrphanUploads({ at });
  }

  async #purgeExpiredChannels(at) {
    const channels = await this.channelRepository.findExpired({ at });
    const expired = [];

    for (const channel of channels) {
      // Members are read before deletion so the notification can be routed to
      // the people who were actually in the channel.
      const memberIds = await this.membershipRepository.listUserIdsByChannel(channel.id);
      const stats = await this.channelCleanupService.purgeChannel(channel.id);

      this.eventBus.emit(DOMAIN_EVENTS.CHANNEL_EXPIRED, {
        channelId: channel.id,
        channelName: channel.name,
        memberIds,
        ...stats,
      });

      expired.push(channel.id);
      logger.info('Channel expired and was deleted', {
        channelId: channel.id,
        name: channel.name,
        ...stats,
      });
    }

    return expired;
  }
}
