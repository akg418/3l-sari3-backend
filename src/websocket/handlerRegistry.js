import { authenticateHandler } from './handlers/auth.handler.js';
import { joinChannelHandler, leaveChannelHandler } from './handlers/channel.handler.js';
import { sendMessageHandler } from './handlers/message.handler.js';
import { markReadHandler } from './handlers/read.handler.js';
import { pingHandler } from './handlers/system.handler.js';

/**
 * The dispatch table for inbound events (Registry pattern).
 *
 * Adding a realtime feature - typing indicators, reactions, read receipts -
 * means writing one handler module and listing it here. No existing file grows.
 */
const handlers = [
  authenticateHandler,
  pingHandler,
  joinChannelHandler,
  leaveChannelHandler,
  sendMessageHandler,
  markReadHandler,
];

export const handlerRegistry = new Map(handlers.map((handler) => [handler.event, handler]));

export const resolveHandler = (event) => handlerRegistry.get(event) ?? null;
