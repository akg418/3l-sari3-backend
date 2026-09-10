import { EventEmitter } from 'node:events';
import { logger } from '../config/logger.js';

/**
 * Application-wide event bus (Observer pattern).
 *
 * It keeps producers such as the channel expiration job completely unaware of
 * transports: the WebSocket layer subscribes to these events, and future
 * consumers (webhooks, analytics, push notifications) can subscribe too
 * without touching the producer.
 */
export const DOMAIN_EVENTS = Object.freeze({
  CHANNEL_CREATED: 'channel.created',
  CHANNEL_EXPIRING: 'channel.expiring',
  CHANNEL_EXPIRED: 'channel.expired',
  CHANNEL_MEMBER_JOINED: 'channel.member.joined',
  CHANNEL_MEMBER_LEFT: 'channel.member.left',
  MESSAGE_CREATED: 'message.created',
});

export const createDomainEventBus = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    emit(event, payload) {
      logger.debug('Domain event emitted', { event });
      emitter.emit(event, payload);
    },
    on(event, listener) {
      // A throwing listener must never take down the producer.
      const safeListener = (payload) => {
        try {
          const result = listener(payload);
          if (result && typeof result.catch === 'function') {
            result.catch((error) =>
              logger.error('Domain event listener failed', { event, error: error.message }),
            );
          }
        } catch (error) {
          logger.error('Domain event listener failed', { event, error: error.message });
        }
      };
      emitter.on(event, safeListener);
      return () => emitter.off(event, safeListener);
    },
    removeAllListeners() {
      emitter.removeAllListeners();
    },
  };
};
