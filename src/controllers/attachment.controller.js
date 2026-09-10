import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../config/logger.js';
import { sendSuccess } from '../utils/response.js';

/** RFC 5987 encoding, so a non-ASCII filename survives the header intact. */
const contentDisposition = (filename, inline) => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

export class AttachmentController {
  constructor({ attachmentService }) {
    this.attachmentService = attachmentService;
  }

  upload = asyncHandler(async (req, res) => {
    const attachment = await this.attachmentService.upload(
      { channelRef: req.validated.params.channelRef, file: req.file },
      req.user,
    );
    sendSuccess(res, { attachment }, { status: 201 });
  });

  /**
   * Streams an attachment to an authorised member.
   *
   * The response headers are as defensive as the upload checks: the declared
   * type comes from our own allowlist, sniffing is disabled, only images are
   * allowed to render inline, and a restrictive CSP applies in case anything
   * does get interpreted as a document.
   */
  download = asyncHandler(async (req, res) => {
    const { channelRef, attachmentId } = req.validated.params;
    const opened = await this.attachmentService.openForDownload(
      { channelRef, attachmentId },
      req.user,
    );

    res.set({
      'Content-Type': opened.contentType,
      'Content-Length': String(opened.attachment.sizeBytes),
      'Content-Disposition': contentDisposition(opened.attachment.filename, opened.inline),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-site',
      // Private: the bytes are authorised per user, so no shared cache may keep them.
      'Cache-Control': 'private, max-age=300, no-transform',
    });

    const stream = opened.stream();
    stream.on('error', (error) => {
      // Headers are already sent by now, so the only honest move is to cut the
      // response off rather than append an error body to a partial file.
      logger.error('Attachment stream failed', { requestId: req.id, error: error.message });
      res.destroy(error);
    });
    stream.pipe(res);
  });

  /** What the client is allowed to upload, so the picker can filter locally. */
  constraints = asyncHandler(async (_req, res) => {
    sendSuccess(res, { upload: this.attachmentService.describeConstraints() });
  });
}
