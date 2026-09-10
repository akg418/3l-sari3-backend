import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ConnectionManager } from './connectionManager.js';
import { RoomRegistry } from './roomRegistry.js';
import { registerRealtimeBridge } from './realtimeBridge.js';
import { createWebSocketServer } from './wsServer.js';
import { onlineUserIdsIn } from './presence.js';

/**
 * Composes the realtime layer and attaches it to an existing HTTP server, so
 * the API and the WebSocket endpoint share one port and one origin.
 */
export const attachWebSocketLayer = ({ httpServer, container }) => {
  const rooms = new RoomRegistry();
  const connections = new ConnectionManager({ heartbeatIntervalMs: env.ws.heartbeatIntervalMs });

  // The HTTP layer was built before this one existed; this is where it gains
  // the ability to report who is actually connected.
  container.presenceReader.bind((channelId) => onlineUserIdsIn(rooms, channelId));

  const unregisterBridge = registerRealtimeBridge({
    eventBus: container.eventBus,
    rooms,
    channelService: container.channelService,
  });

  const wss = createWebSocketServer({
    httpServer,
    rooms,
    connections,
    services: {
      authService: container.authService,
      tokenService: container.tokenService,
      channelService: container.channelService,
      messageService: container.messageService,
    },
  });

  connections.startHeartbeat();
  logger.info('WebSocket layer attached', { path: env.ws.path });

  return {
    wss,
    rooms,
    connections,
    close: async () => {
      container.presenceReader.unbind();
      unregisterBridge();
      connections.stopHeartbeat();
      connections.closeAll(1001, 'Server shutting down');
      await new Promise((resolve) => wss.close(resolve));
    },
  };
};
