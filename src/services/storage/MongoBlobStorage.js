import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { TTL_GRACE_SECONDS } from '../../constants/domain.js';

/**
 * Attachment bytes kept in MongoDB, so the API never writes to local disk -
 * which is what lets it run on a read-only serverless filesystem (Vercel).
 *
 * One document per file, well under MongoDB's 16 MB document cap given the
 * upload limits. `scope` is the channel id, so a channel's files go in one delete.
 */
const blobSchema = new mongoose.Schema(
  {
    _id: { type: String },
    scope: { type: String, required: true },
    data: { type: Buffer, required: true },
    /** Mirrors the channel, so bytes cannot outlive it even if the app is down. */
    expiresAt: { type: Date, default: null },
  },
  { collection: 'attachment_blobs', versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);

blobSchema.index({ scope: 1 }, { name: 'idx_blob_scope' });
blobSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: TTL_GRACE_SECONDS, name: 'ttl_blob_expires_at' },
);

const AttachmentBlob =
  mongoose.models.AttachmentBlob ?? mongoose.model('AttachmentBlob', blobSchema);

export class MongoBlobStorage {
  constructor({ model = AttachmentBlob } = {}) {
    this.model = model;
  }

  async ensureReady() {}

  async save({ scope, key, buffer, expiresAt = null }) {
    await this.model.create({ _id: key, scope, data: buffer, expiresAt });
  }

  async exists({ scope, key }) {
    return Boolean(await this.model.exists({ _id: key, scope }).exec());
  }

  /** Returned synchronously, as the controller expects; the read happens on first pull. */
  createReadStream({ scope, key }) {
    const { model } = this;
    return Readable.from(
      (async function* read() {
        const blob = await model.findOne({ _id: key, scope }).lean().exec();
        if (!blob) throw new Error('Attachment bytes not found');
        yield Buffer.from(blob.data.buffer ?? blob.data);
      })(),
    );
  }

  async delete({ scope, key }) {
    await this.model.deleteOne({ _id: key, scope }).exec();
  }

  async deleteScope(scope) {
    await this.model.deleteMany({ scope }).exec();
  }

  listScopes() {
    return this.model.distinct('scope').exec();
  }
}
