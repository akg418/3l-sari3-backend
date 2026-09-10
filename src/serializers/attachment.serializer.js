import { ATTACHMENT_KINDS } from '../constants/domain.js';

/**
 * Builds the download path for an attachment.
 *
 * It is derived here rather than stored, so every route to the bytes goes
 * through the channel's authorisation check. There is deliberately no signed or
 * public variant: a URL alone must never be enough to read a file.
 */
export const attachmentUrl = ({ channelId, attachmentId }) =>
  `/api/channels/${channelId}/attachments/${attachmentId}`;

export const toPublicAttachment = (attachment, { channelId }) => ({
  id: attachment.id,
  kind: attachment.kind,
  filename: attachment.filename,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
  isImage: attachment.kind === ATTACHMENT_KINDS.IMAGE,
  url: attachmentUrl({ channelId, attachmentId: attachment.id }),
  metadata: attachment.metadata ?? {},
});

export const toPublicAttachmentList = (attachments, context) =>
  (attachments ?? []).map((attachment) => toPublicAttachment(attachment, context));
