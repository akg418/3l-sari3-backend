import { BaseRepository, isDuplicateKeyError } from './BaseRepository.js';
import { User } from '../models/user.model.js';

export class UserRepository extends BaseRepository {
  constructor(model = User) {
    super(model);
  }

  /** Returns the public projection (no password hash). */
  async findById(id) {
    const user = await this.model.findById(id).exec();
    return user ? user.toJSON() : null;
  }

  /** Includes the password hash - only for the login flow. */
  async findByUsernameKeyWithSecret(usernameKey) {
    const user = await this.model.findOne({ usernameKey }).select('+passwordHash').exec();
    if (!user) return null;
    return { ...user.toJSON(), passwordHash: user.passwordHash };
  }

  /** Bulk lookup for member lists, so a roster costs one query. */
  async findManyByIds(ids) {
    if (ids.length === 0) return [];
    const users = await this.model.find({ _id: { $in: ids } }).exec();
    return users.map((user) => user.toJSON());
  }

  existsByUsernameKey(usernameKey) {
    return this.model.exists({ usernameKey }).exec();
  }

  isDuplicateUsername(error) {
    return isDuplicateKeyError(error, 'usernameKey');
  }
}
