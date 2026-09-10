import { ATTACHMENT_KINDS } from './domain.js';

/**
 * The attachment allowlist.
 *
 * Nothing outside this table can be uploaded. That is deliberate: an allowlist
 * fails closed, so a type nobody considered - SVG (scriptable), HTML, a shell
 * script, a binary - is rejected without needing its own rule.
 *
 * `signatures` are magic-byte groups. An entry matches when *every* group in
 * one alternative matches, which is how container formats such as WebP are
 * expressed. `signatures: null` marks a format that genuinely has no reliable
 * signature (plain text and friends); those are only ever served as downloads.
 */
const sig = (offset, ...bytes) => ({ offset, bytes });

export const ALLOWED_ATTACHMENT_TYPES = Object.freeze({
  'image/png': {
    kind: ATTACHMENT_KINDS.IMAGE,
    extension: 'png',
    signatures: [[sig(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)]],
  },
  'image/jpeg': {
    kind: ATTACHMENT_KINDS.IMAGE,
    extension: 'jpg',
    signatures: [[sig(0, 0xff, 0xd8, 0xff)]],
  },
  'image/gif': {
    kind: ATTACHMENT_KINDS.IMAGE,
    extension: 'gif',
    signatures: [
      [sig(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61)],
      [sig(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)],
    ],
  },
  'image/webp': {
    kind: ATTACHMENT_KINDS.IMAGE,
    extension: 'webp',
    // "RIFF" .... "WEBP" - the size field in between is not part of the check.
    signatures: [[sig(0, 0x52, 0x49, 0x46, 0x46), sig(8, 0x57, 0x45, 0x42, 0x50)]],
  },

  'application/pdf': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'pdf',
    signatures: [[sig(0, 0x25, 0x50, 0x44, 0x46, 0x2d)]],
  },
  'application/zip': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'zip',
    signatures: [[sig(0, 0x50, 0x4b, 0x03, 0x04)], [sig(0, 0x50, 0x4b, 0x05, 0x06)]],
  },
  // The OpenXML office formats are ZIP containers, hence the same signature.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'docx',
    signatures: [[sig(0, 0x50, 0x4b, 0x03, 0x04)]],
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'xlsx',
    signatures: [[sig(0, 0x50, 0x4b, 0x03, 0x04)]],
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'pptx',
    signatures: [[sig(0, 0x50, 0x4b, 0x03, 0x04)]],
  },
  // Legacy OLE2 office documents.
  'application/msword': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'doc',
    signatures: [[sig(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)]],
  },
  'application/vnd.ms-excel': {
    kind: ATTACHMENT_KINDS.FILE,
    extension: 'xls',
    signatures: [[sig(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)]],
  },

  'text/plain': { kind: ATTACHMENT_KINDS.FILE, extension: 'txt', signatures: null },
  'text/csv': { kind: ATTACHMENT_KINDS.FILE, extension: 'csv', signatures: null },
  'text/markdown': { kind: ATTACHMENT_KINDS.FILE, extension: 'md', signatures: null },
  'application/json': { kind: ATTACHMENT_KINDS.FILE, extension: 'json', signatures: null },
});

export const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(ALLOWED_ATTACHMENT_TYPES));

export const IMAGE_MIME_TYPES = Object.freeze(
  ALLOWED_MIME_TYPES.filter((mime) => ALLOWED_ATTACHMENT_TYPES[mime].kind === ATTACHMENT_KINDS.IMAGE),
);

const matchesGroup = (buffer, { offset, bytes }) => {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
};

const matchesType = (buffer, descriptor) => {
  if (!descriptor.signatures) return false;
  return descriptor.signatures.some((alternative) =>
    alternative.every((group) => matchesGroup(buffer, group)),
  );
};

/**
 * Decides what a file actually is, from its bytes.
 *
 * The client's declared Content-Type is a hint, never the answer: it is only
 * honoured when the bytes agree with it. A payload whose declared type claims a
 * signature it does not have is rejected, so renaming an executable to .png
 * gets it nowhere.
 *
 * Returns `null` when nothing in the allowlist fits.
 */
export const resolveAttachmentType = (buffer, declaredMimeType) => {
  const declared = ALLOWED_ATTACHMENT_TYPES[declaredMimeType];

  if (declared) {
    // Signature-less formats (plain text, CSV, JSON) have nothing to verify
    // against; they are always served as downloads, never inline.
    if (declared.signatures === null) {
      return { mimeType: declaredMimeType, ...declared };
    }
    if (matchesType(buffer, declared)) {
      return { mimeType: declaredMimeType, ...declared };
    }
  }

  // Fall back to whatever the bytes themselves say.
  for (const [mimeType, descriptor] of Object.entries(ALLOWED_ATTACHMENT_TYPES)) {
    if (matchesType(buffer, descriptor)) return { mimeType, ...descriptor };
  }

  return null;
};
