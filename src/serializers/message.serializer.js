import { toPublicAttachmentList } from './attachment.serializer.js';

export const toPublicMessage = (message) => ({
  id: message.id,
  channelId: message.channelId,
  sender: { id: message.senderId, username: message.senderUsername },
  messageType: message.messageType,
  content: message.content,
  attachments: toPublicAttachmentList(message.attachments, { channelId: message.channelId }),
  metadata: message.metadata ?? {},
  createdAt: new Date(message.createdAt).toISOString(),
});

export const toPublicMessageList = (messages) => messages.map(toPublicMessage);
