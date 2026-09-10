import { env } from './config/env.js';
import { createDomainEventBus } from './utils/domainEvents.js';
import { createPresenceReader } from './utils/presenceReader.js';
import {
  AttachmentRepository,
  ChannelMembershipRepository,
  ChannelRepository,
  MessageRepository,
  UserRepository,
} from './repositories/index.js';
import { createStorage } from './services/storage/index.js';
import { PasswordService } from './services/password.service.js';
import { TokenService } from './services/token.service.js';
import { AuthService } from './services/auth.service.js';
import { ChannelService } from './services/channel.service.js';
import { ChannelCleanupService } from './services/channelCleanup.service.js';
import { AttachmentService } from './services/attachment.service.js';
import { MessageService } from './services/message.service.js';
import { ChannelExpirationJob } from './jobs/channelExpiration.job.js';
import { AuthController } from './controllers/auth.controller.js';
import { ChannelController } from './controllers/channel.controller.js';
import { MessageController } from './controllers/message.controller.js';
import { AttachmentController } from './controllers/attachment.controller.js';

/**
 * Composition root.
 *
 * Every dependency is constructed once, here, and injected downwards. Nothing
 * in the application imports a singleton service, which is what lets a test
 * build the same graph with a fake repository, a stub event bus or a temporary
 * storage directory.
 */
export const createContainer = ({ eventBus = createDomainEventBus(), overrides = {} } = {}) => {
  const userRepository = overrides.userRepository ?? new UserRepository();
  const channelRepository = overrides.channelRepository ?? new ChannelRepository();
  const messageRepository = overrides.messageRepository ?? new MessageRepository();
  const membershipRepository = overrides.membershipRepository ?? new ChannelMembershipRepository();
  const attachmentRepository = overrides.attachmentRepository ?? new AttachmentRepository();

  const storage = overrides.storage ?? createStorage();
  const passwordService = overrides.passwordService ?? new PasswordService();
  const tokenService = overrides.tokenService ?? new TokenService();

  // Filled in by the realtime layer; harmlessly empty without one.
  const presenceReader = overrides.presenceReader ?? createPresenceReader();

  const authService = new AuthService({ userRepository, passwordService, tokenService });

  const channelService = new ChannelService({
    channelRepository,
    membershipRepository,
    messageRepository,
    userRepository,
    passwordService,
    eventBus,
    config: env.channel,
  });

  const attachmentService = new AttachmentService({
    attachmentRepository,
    channelService,
    storage,
    config: env.uploads,
  });

  const messageService = new MessageService({
    messageRepository,
    channelService,
    attachmentService,
    eventBus,
  });

  /**
   * Deletion is its own service: it is the only thing that touches both the
   * database and the file store, and keeping it out of ChannelService avoids a
   * cycle with the attachment service.
   */
  const channelCleanupService = new ChannelCleanupService({
    channelRepository,
    messageRepository,
    membershipRepository,
    attachmentRepository,
    storage,
  });

  const channelExpirationJob = new ChannelExpirationJob({
    channelRepository,
    membershipRepository,
    channelCleanupService,
    eventBus,
    config: env.channel,
  });

  return {
    eventBus,
    presenceReader,
    storage,

    userRepository,
    channelRepository,
    messageRepository,
    membershipRepository,
    attachmentRepository,

    passwordService,
    tokenService,
    authService,
    channelService,
    channelCleanupService,
    attachmentService,
    messageService,

    channelExpirationJob,

    authController: new AuthController({ authService }),
    channelController: new ChannelController({ channelService, presenceReader }),
    messageController: new MessageController({ messageService }),
    attachmentController: new AttachmentController({ attachmentService }),
  };
};
