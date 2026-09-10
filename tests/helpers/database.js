import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';

// Importing the models registers them with mongoose before indexes are synced.
import '../../src/models/index.js';

let memoryServer = null;

/**
 * Resolves a database for the suite, preferring an explicitly configured one,
 * then an in-memory server (the usual CI setup), then a local mongod.
 */
const resolveUri = async () => {
  if (process.env.MONGODB_URI_TEST) return process.env.MONGODB_URI_TEST;

  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    return memoryServer.getUri('ephemeral_chat_test');
  } catch {
    return `mongodb://127.0.0.1:27017/ephemeral_chat_test_${Date.now()}`;
  }
};

export const setupTestDatabase = async () => {
  await connectDatabase(await resolveUri());
};

export const clearTestDatabase = async () => {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
};

export const teardownTestDatabase = async () => {
  const uri = mongoose.connection.client?.s?.url ?? '';
  // Only drop databases this suite created; never a database handed to us.
  if (!process.env.MONGODB_URI_TEST || uri.includes('_test')) {
    await mongoose.connection.dropDatabase();
  }
  await disconnectDatabase();
  await memoryServer?.stop();
  memoryServer = null;
};

export { mongoose };
