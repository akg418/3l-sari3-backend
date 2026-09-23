import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';

export class MessageController {
  constructor({ messageService }) {
    this.messageService = messageService;
  }

  list = asyncHandler(async (req, res) => {
    const { limit, beforeCreatedAt, beforeId, afterCreatedAt, afterId } = req.validated.query;

    const result = await this.messageService.listHistory(
      {
        channelRef: req.validated.params.channelRef,
        limit,
        before: beforeCreatedAt ? { createdAt: beforeCreatedAt, id: beforeId } : undefined,
        after: afterCreatedAt ? { createdAt: afterCreatedAt, id: afterId } : undefined,
      },
      req.user,
    );

    sendSuccess(res, result);
  });

  /** HTTP twin of the `message:send` socket event, for clients without a socket. */
  send = asyncHandler(async (req, res) => {
    const { content, messageType, attachmentIds, clientMessageId } = req.validated.body;

    const message = await this.messageService.createMessage(
      { channelRef: req.validated.params.channelRef, content, messageType, attachmentIds },
      req.user,
    );

    sendSuccess(res, { message, clientMessageId: clientMessageId ?? null }, { status: 201 });
  });
}
