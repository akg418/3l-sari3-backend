import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Scopes and keys are server-generated UUIDs; anything else is refused. */
const SAFE_SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

const assertSafe = (segment) => {
  if (!SAFE_SEGMENT.test(String(segment))) throw new Error('Unsafe storage path segment');
  return segment;
};

/**
 * Files on local disk, grouped per channel: `<directory>/<scope>/<key>`.
 * Only for long-running hosts and tests - serverless hosts use MongoBlobStorage.
 */
export class LocalFileStorage {
  constructor({ directory }) {
    this.root = path.resolve(directory);
  }

  #pathFor(scope, key) {
    return key === undefined
      ? path.join(this.root, assertSafe(scope))
      : path.join(this.root, assertSafe(scope), assertSafe(key));
  }

  async ensureReady() {
    await fsp.mkdir(this.root, { recursive: true });
  }

  async save({ scope, key, buffer }) {
    await fsp.mkdir(this.#pathFor(scope), { recursive: true });
    await fsp.writeFile(this.#pathFor(scope, key), buffer, { flag: 'wx' });
  }

  async exists({ scope, key }) {
    try {
      await fsp.access(this.#pathFor(scope, key));
      return true;
    } catch {
      return false;
    }
  }

  createReadStream({ scope, key }) {
    return fs.createReadStream(this.#pathFor(scope, key));
  }

  async delete({ scope, key }) {
    await fsp.rm(this.#pathFor(scope, key), { force: true });
  }

  async deleteScope(scope) {
    await fsp.rm(this.#pathFor(scope), { recursive: true, force: true });
  }

  async listScopes() {
    try {
      const entries = await fsp.readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}
