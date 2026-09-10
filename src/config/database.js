import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

/**
 * Connects to MongoDB and makes sure every declared index actually exists.
 * Index creation is awaited on purpose: channel-name and username uniqueness
 * are enforced at the database level, not just in application code.
 */
export const connectDatabase = async (uri = env.mongoUri) => {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
  });

  logger.info('Connected to MongoDB');
  await syncIndexes();
  return mongoose.connection;
};

export const syncIndexes = async () => {
  const models = Object.values(mongoose.models);
  await Promise.all(models.map((model) => model.createIndexes()));
  logger.debug('MongoDB indexes ensured', { models: models.map((m) => m.modelName) });
};

export const disconnectDatabase = async () => {
  await mongoose.connection.close();
  logger.info('Disconnected from MongoDB');
};
