import { Router } from 'express';
import { validate } from '../middlewares/validate.js';
import { uploadSingleAttachment } from '../middlewares/upload.js';
import { uploadRateLimiter } from '../middlewares/rateLimiters.js';
import {
  attachmentParamSchema,
  channelRefParamSchema,
  createChannelSchema,
  joinChannelSchema,
  listChannelsSchema,
} from '../validators/channel.validator.js';
import { listMessagesSchema, sendMessageSchema } from '../validators/message.validator.js';

/**
 * `:channelRef` is either a channel's unique name or its UUID, which is what
 * lets a shared link read `/channels/general` while ids stay canonical inside
 * the system. Collections are declared before the parameterised routes so a
 * literal path such as `/mine` is never mistaken for a channel name.
 */
export const createChannelRouter = ({
  channelController,
  messageController,
  attachmentController,
  authenticate,
}) => {
  const router = Router();

  // Everything below this line requires a valid access token.
  router.use(authenticate);

  router.get('/', validate(listChannelsSchema), channelController.list);
  router.post('/', validate(createChannelSchema), channelController.create);
  router.get('/mine', channelController.listMine);
  router.get('/quota', channelController.quota);
  router.get('/upload-constraints', attachmentController.constraints);

  router.get('/:channelRef', validate(channelRefParamSchema), channelController.get);
  router.get('/:channelRef/members', validate(channelRefParamSchema), channelController.members);
  router.post('/:channelRef/join', validate(joinChannelSchema), channelController.join);
  router.post('/:channelRef/leave', validate(channelRefParamSchema), channelController.leave);
  router.post('/:channelRef/read', validate(channelRefParamSchema), channelController.markRead);
  router.get('/:channelRef/messages', validate(listMessagesSchema), messageController.list);
  router.post('/:channelRef/messages', validate(sendMessageSchema), messageController.send);

  router.post(
    '/:channelRef/attachments',
    uploadRateLimiter,
    // Multipart is parsed before validation so `req.file` exists to check.
    uploadSingleAttachment,
    validate(channelRefParamSchema),
    attachmentController.upload,
  );
  router.get(
    '/:channelRef/attachments/:attachmentId',
    validate(attachmentParamSchema),
    attachmentController.download,
  );

  return router;
};
