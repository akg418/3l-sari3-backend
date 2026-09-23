import { env } from '../../config/env.js';
import { LocalFileStorage } from './LocalFileStorage.js';
import { MongoBlobStorage } from './MongoBlobStorage.js';

export { LocalFileStorage, MongoBlobStorage };

/**
 * `mongo` (default) keeps bytes in the database and never touches disk, which
 * serverless hosts require. `local` writes to UPLOAD_DIR.
 */
export const createStorage = () =>
  env.uploads.storageDriver === 'local'
    ? new LocalFileStorage({ directory: env.uploads.directory })
    : new MongoBlobStorage();
