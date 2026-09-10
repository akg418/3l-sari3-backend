import { parsePayload } from '../../middlewares/validate.js';
import { sendMessagePayloadSchema } from '../../validators/message.validator.js';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../events.js';

/**
 * The sender identity always comes from the authenticated socket, never from
 * the payload, so a client cannot post as somebody else. Membership, channel
 * liveness and attachment ownership are all re-checked inside the services on
 * every send.
 *
 * Fan-out is not done here: persisting a message emits a domain event, and the
 * realtime bridge turns that into the `message:new` broadcast. This handler
 * only returns the acknowledgement the sender needs to reconcile its
 * optimistic bubble.
 */
export const sendMessageHandler = {
  event: CLIENT_EVENTS.MESSAGE_SEND,
  requiresAuth: true,
  handle: async (connection, payload, ctx) => {
    const { channelId, content, messageType, attachmentIds, clientMessageId } = parsePayload(
      sendMessagePayloadSchema,
      payload,
    );

    const message = await ctx.services.messageService.createMessage(
      { channelId, content, messageType, attachmentIds },
      connection.user,
    );

    connection.send(
      SERVER_EVENTS.MESSAGE_ACK,
      { messageId: message.id, channelId, clientMessageId: clientMessageId ?? null },
      { requestId: ctx.requestId },
    );
  },
};
