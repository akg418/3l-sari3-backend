import { timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { logger } from '../config/logger.js';
import { forbidden, notFound } from '../utils/AppError.js';

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * All-time usage numbers, behind an access code.
 *
 * Users are never deleted, so they are counted live. Channels and messages are
 * deleted on expiry, so they are tallied by counters that only increase.
 */
export class StatsService {
  #seeded = null;

  constructor({ statsRepository, userRepository, channelRepository, messageRepository, config }) {
    this.statsRepository = statsRepository;
    this.userRepository = userRepository;
    this.channelRepository = channelRepository;
    this.messageRepository = messageRepository;
    this.config = config;
  }

  /**
   * First use on a database that predates the counters: start them from what
   * still exists, rather than from zero. Once per process.
   */
  #ensureSeeded() {
    this.#seeded ??= Promise.all([
      this.channelRepository.countDocuments(),
      this.messageRepository.countDocuments(),
    ])
      .then(([channelsCreated, messagesSent]) =>
        this.statsRepository.seed({ channelsCreated, messagesSent }),
      )
      .catch((error) => {
        this.#seeded = null;
        throw error;
      });
    return this.#seeded;
  }

  /**
   * Called before a channel or message is written, so a first-time seed
   * cannot count the very row that is about to be recorded. Never throws.
   */
  async ready() {
    try {
      await this.#ensureSeeded();
    } catch (error) {
      logger.error('Failed to seed stats', { error: error.message });
    }
  }

  /** Never fails the caller: a lost tick is better than a lost message. */
  async #record(field) {
    try {
      await this.statsRepository.increment(field);
    } catch (error) {
      logger.error('Failed to record stat', { field, error: error.message });
    }
  }

  recordChannelCreated() {
    return this.#record('channelsCreated');
  }

  recordMessageSent() {
    return this.#record('messagesSent');
  }

  assertAccess(code) {
    if (!this.config.accessCode) {
      throw notFound(ERROR_CODES.STATS_DISABLED, 'Statistics are not enabled.');
    }
    if (!sameSecret(code, this.config.accessCode)) {
      throw forbidden(ERROR_CODES.STATS_CODE_INVALID, 'Incorrect access code.');
    }
  }

  async getStats(code) {
    this.assertAccess(code);
    await this.#ensureSeeded();

    const [counters, totalUsers, activeChannels] = await Promise.all([
      this.statsRepository.get(),
      this.userRepository.countDocuments(),
      this.channelRepository.countActive(),
    ]);

    return {
      totalUsers,
      totalChannelsCreated: counters.channelsCreated,
      totalMessagesSent: counters.messagesSent,
      activeChannels,
      generatedAt: new Date().toISOString(),
    };
  }
}
