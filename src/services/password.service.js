import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/**
 * Single place where hashing happens, for both user passwords and private
 * channel passwords. Swapping bcrypt for argon2 later touches only this file.
 */
export class PasswordService {
  #dummyHash = null;

  constructor({ saltRounds = env.auth.bcryptSaltRounds } = {}) {
    this.saltRounds = saltRounds;
  }

  hash(plainText) {
    return bcrypt.hash(plainText, this.saltRounds);
  }

  compare(plainText, hash) {
    if (!hash) return Promise.resolve(false);
    return bcrypt.compare(plainText, hash);
  }

  /**
   * A real hash of a value nobody knows, used to keep "unknown user" and
   * "wrong password" indistinguishable in both response and timing.
   * Built once, on first use, so it never slows down startup.
   */
  get dummyHash() {
    this.#dummyHash ??= bcrypt.hashSync(randomUUID(), this.saltRounds);
    return this.#dummyHash;
  }
}
