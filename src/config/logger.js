import { env } from './env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

const write = (level, message, meta) => {
  if (LEVELS[level] > threshold) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };

  const line = env.isProduction
    ? JSON.stringify(entry)
    : `${entry.ts} [${level.toUpperCase()}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;

  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};
