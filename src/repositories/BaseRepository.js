export const MONGO_DUPLICATE_KEY = 11000;

export const isDuplicateKeyError = (error, indexName) =>
  error?.code === MONGO_DUPLICATE_KEY &&
  (indexName === undefined ||
    error?.message?.includes(indexName) ||
    Object.keys(error?.keyPattern ?? {}).includes(indexName));

/**
 * Thin persistence boundary. Repositories return plain objects (`lean`) so no
 * mongoose document ever leaks into the service layer - which keeps services
 * unit-testable against a fake repository.
 */
export class BaseRepository {
  constructor(model) {
    this.model = model;
  }

  async create(data) {
    const document = await this.model.create(data);
    return document.toJSON();
  }

  findById(id) {
    return this.model.findById(id).lean({ virtuals: true }).exec();
  }

  deleteById(id) {
    return this.model.deleteOne({ _id: id }).exec();
  }

  countDocuments(filter = {}) {
    return this.model.countDocuments(filter).exec();
  }
}
