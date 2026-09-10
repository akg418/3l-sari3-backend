import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  IMAGE_MIME_TYPES,
  resolveAttachmentType,
} from '../../src/constants/attachments.js';

const withHeader = (bytes, padding = 16) =>
  Buffer.concat([Buffer.from(bytes), Buffer.alloc(padding, 0x00)]);

const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0]);
const GIF = withHeader([...Buffer.from('GIF89a')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const PDF = withHeader([...Buffer.from('%PDF-')]);
const ZIP = withHeader([0x50, 0x4b, 0x03, 0x04]);
const ELF = withHeader([0x7f, 0x45, 0x4c, 0x46]);
const MACHO = withHeader([0xcf, 0xfa, 0xed, 0xfe]);

describe('Attachment type resolution', () => {
  it('exposes an allowlist, not a blocklist', () => {
    expect(ALLOWED_MIME_TYPES.length).toBeGreaterThan(0);
    expect(IMAGE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  });

  it.each([
    ['PNG', PNG, 'image/png', 'image/png', 'image'],
    ['JPEG', JPEG, 'image/jpeg', 'image/jpeg', 'image'],
    ['GIF', GIF, 'image/gif', 'image/gif', 'image'],
    ['WebP', WEBP, 'image/webp', 'image/webp', 'image'],
    ['PDF', PDF, 'application/pdf', 'application/pdf', 'file'],
    ['ZIP', ZIP, 'application/zip', 'application/zip', 'file'],
  ])('identifies %s from its bytes', (_label, buffer, declared, expectedMime, expectedKind) => {
    expect(resolveAttachmentType(buffer, declared)).toMatchObject({
      mimeType: expectedMime,
      kind: expectedKind,
    });
  });

  it('accepts signature-less text formats on their declared type', () => {
    const text = Buffer.from('id,name\n1,ada');
    expect(resolveAttachmentType(text, 'text/csv')).toMatchObject({
      mimeType: 'text/csv',
      kind: 'file',
    });
  });

  describe('when the declared type and the bytes disagree', () => {
    it('rejects an executable claiming to be an image', () => {
      expect(resolveAttachmentType(ELF, 'image/png')).toBeNull();
      expect(resolveAttachmentType(MACHO, 'image/jpeg')).toBeNull();
    });

    it('rejects script-capable and markup formats outright', () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect(resolveAttachmentType(svg, 'image/svg+xml')).toBeNull();
      expect(resolveAttachmentType(svg, 'image/png')).toBeNull();
      expect(resolveAttachmentType(Buffer.from('<html>'), 'text/html')).toBeNull();
      expect(resolveAttachmentType(Buffer.from('alert(1)'), 'application/javascript')).toBeNull();
    });

    it('trusts the bytes when the declared type is uselessly generic', () => {
      expect(resolveAttachmentType(PNG, 'application/octet-stream')).toMatchObject({
        mimeType: 'image/png',
      });
    });

    it('keeps a specific declared type when the container signature agrees', () => {
      // docx is a ZIP; the declared type is the more useful of the two.
      const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      expect(resolveAttachmentType(ZIP, docx).mimeType).toBe(docx);
    });

    it('rejects an empty or truncated payload', () => {
      expect(resolveAttachmentType(Buffer.alloc(0), 'image/png')).toBeNull();
      expect(resolveAttachmentType(Buffer.from([0x89, 0x50]), 'image/png')).toBeNull();
    });
  });
});
