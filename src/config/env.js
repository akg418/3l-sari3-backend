import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * The application refuses to boot with an invalid configuration: failing at
 * startup is far cheaper than discovering a missing secret at request time.
 */
const booleanish = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value === 'true'));

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3005),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  CORS_ORIGINS: csv,

  CHANNEL_MAX_DURATION_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
  CHANNEL_MAX_ACTIVE_PER_USER: z.coerce.number().int().positive().max(100).default(4),
  CHANNEL_MIN_DURATION_MINUTES: z.coerce.number().int().positive().default(1),
  CHANNEL_EXPIRY_WARNING_SECONDS: z.coerce.number().int().positive().default(60),
  CHANNEL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(200).default(1000),

  WS_PATH: z.string().startsWith('/').default('/ws'),
  WS_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  WS_RATE_LIMIT_MAX_EVENTS: z.coerce.number().int().positive().default(60),

  UPLOAD_DIR: z.string().min(1).default('./storage/uploads'),
  UPLOAD_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  UPLOAD_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  UPLOAD_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  TRUST_PROXY: booleanish(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const raw = parsed.data;

export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  trustProxy: raw.TRUST_PROXY,

  mongoUri: raw.MONGODB_URI,

  auth: {
    jwtSecret: raw.JWT_SECRET,
    jwtExpiresIn: raw.JWT_EXPIRES_IN,
    bcryptSaltRounds: raw.BCRYPT_SALT_ROUNDS,
  },

  corsOrigins: raw.CORS_ORIGINS,

  channel: {
    maxDurationMinutes: raw.CHANNEL_MAX_DURATION_MINUTES,
    minDurationMinutes: raw.CHANNEL_MIN_DURATION_MINUTES,
    maxActivePerUser: raw.CHANNEL_MAX_ACTIVE_PER_USER,
    expiryWarningSeconds: raw.CHANNEL_EXPIRY_WARNING_SECONDS,
    sweepIntervalMs: raw.CHANNEL_SWEEP_INTERVAL_MS,
  },

  uploads: {
    directory: raw.UPLOAD_DIR,
    maxImageBytes: raw.UPLOAD_MAX_IMAGE_BYTES,
    maxFileBytes: raw.UPLOAD_MAX_FILE_BYTES,
    /** The cap multer enforces; the per-kind limits are checked after sniffing. */
    maxAnyBytes: Math.max(raw.UPLOAD_MAX_IMAGE_BYTES, raw.UPLOAD_MAX_FILE_BYTES),
  },

  ws: {
    path: raw.WS_PATH,
    authTimeoutMs: raw.WS_AUTH_TIMEOUT_MS,
    heartbeatIntervalMs: raw.WS_HEARTBEAT_INTERVAL_MS,
    rateLimit: {
      windowMs: raw.WS_RATE_LIMIT_WINDOW_MS,
      maxEvents: raw.WS_RATE_LIMIT_MAX_EVENTS,
    },
  },

  rateLimit: {
    general: { windowMs: raw.RATE_LIMIT_WINDOW_MS, max: raw.RATE_LIMIT_MAX_REQUESTS },
    auth: { windowMs: raw.AUTH_RATE_LIMIT_WINDOW_MS, max: raw.AUTH_RATE_LIMIT_MAX_REQUESTS },
    upload: { windowMs: raw.UPLOAD_RATE_LIMIT_WINDOW_MS, max: raw.UPLOAD_RATE_LIMIT_MAX_REQUESTS },
  },

  logLevel: raw.LOG_LEVEL,
});
