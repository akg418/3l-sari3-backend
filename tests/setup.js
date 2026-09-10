/**
 * Runs before any test file imports application code, so the configuration
 * schema in src/config/env.js sees a complete, valid environment.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-value-that-is-long-enough-1234567890';
process.env.JWT_EXPIRES_IN = '1h';
// The cheapest cost bcrypt accepts: hashing is not what these tests exercise.
process.env.BCRYPT_SALT_ROUNDS = '4';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/ephemeral_chat_test';
process.env.CORS_ORIGINS = 'http://localhost:3006';
