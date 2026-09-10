import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';

export class MessageController {
  constructor({ messageService }) {
    this.messageService = messageService;
  }

  list = asyncHandler(async (req, res) => {
    const { limit, beforeCreatedAt, beforeId } = req.validated.query;

    const result = await this.messageService.listHistory(
      {
        channelRef: req.validated.params.channelRef,
        limit,
        before: beforeCreatedAt ? { createdAt: beforeCreatedAt, id: beforeId } : undefined,
      },
      req.user,
    );

    sendSuccess(res, result);
  });
}
