import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';

export const STATS_CODE_HEADER = 'x-stats-code';

export class StatsController {
  constructor({ statsService }) {
    this.statsService = statsService;
  }

  get = asyncHandler(async (req, res) => {
    sendSuccess(res, { stats: await this.statsService.getStats(req.get(STATS_CODE_HEADER)) });
  });
}
