import { BaseRepository, isDuplicateKeyError } from './BaseRepository.js';
import { Stats } from '../models/stats.model.js';

const GLOBAL_ID = 'global';

export class StatsRepository extends BaseRepository {
  constructor(model = Stats) {
    super(model);
  }

  /**
   * Creates the counters document with starting values, if it does not exist
   * yet. Never touches an existing one, so it is safe to call repeatedly.
   */
  async seed({ channelsCreated, messagesSent }) {
    try {
      await this.model
        .updateOne(
          { _id: GLOBAL_ID },
          { $setOnInsert: { channelsCreated, messagesSent } },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      // Another instance seeded it at the same moment.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  increment(field, by = 1) {
    return this.model
      .updateOne({ _id: GLOBAL_ID }, { $inc: { [field]: by } }, { upsert: true })
      .exec();
  }

  async get() {
    const stats = await this.model.findById(GLOBAL_ID).lean().exec();
    return {
      channelsCreated: stats?.channelsCreated ?? 0,
      messagesSent: stats?.messagesSent ?? 0,
    };
  }
}
