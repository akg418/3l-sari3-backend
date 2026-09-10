import { uuid } from '../../utils/id.js';

/**
 * Uses a UUID string as the document's `_id`.
 *
 * MongoDB ObjectIds are never exposed by this API, and giving the UUID the
 * primary-key slot avoids carrying a second unique index on every collection.
 * `toJSON` exposes it as `id`, so no ObjectId-shaped value ever leaves the API.
 *
 * `generator` lets a collection choose a time-ordered UUID instead of a random
 * one - see `uuidV7` and the message model.
 */
export const uuidPrimaryKey = (schema, { hidden = [], generator = uuid } = {}) => {
  schema.add({
    _id: {
      type: String,
      default: generator,
    },
  });

  schema.set('versionKey', false);
  schema.set('id', false);

  schema.virtual('id').get(function getId() {
    return this._id;
  });

  const transform = (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    for (const field of hidden) delete ret[field];
    return ret;
  };

  schema.set('toJSON', { virtuals: true, transform });
  schema.set('toObject', { virtuals: true, transform });
};
