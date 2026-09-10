import { randomBytes, randomUUID } from 'node:crypto';

/** Random UUID (version 4). The default for entities with no natural order. */
export const uuid = () => randomUUID();
/** Any UUID version this system issues (v4 for entities, v7 for messages). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);


const SEQUENCE_BITS = 12;
const SEQUENCE_MAX = (1 << SEQUENCE_BITS) - 1;
// Seeded well below the maximum so a burst inside one millisecond has room to
// increment without rolling over.
const SEQUENCE_SEED_MASK = 0x0ff;

let lastTimestamp = -1;
let sequence = 0;

/**
 * Time-ordered UUID (version 7, RFC 9562): a 48-bit millisecond timestamp
 * followed by a monotonic counter and random bits.
 *
 * Messages need this rather than a v4 id. Two messages sent in the same
 * millisecond have identical `createdAt` values, so the id is what breaks the
 * tie - and a random id would order them arbitrarily, showing a transcript out
 * of order and corrupting keyset pagination. As a bonus, monotonic ids keep
 * inserts at the right-hand edge of the `_id` index instead of scattering
 * writes across it.
 */
export const uuidV7 = () => {
  let timestamp = Date.now();

  if (timestamp === lastTimestamp) {
    sequence += 1;
    // Overflowing the counter borrows from the next millisecond, which keeps
    // ids strictly increasing at the cost of a negligible clock skew.
    if (sequence > SEQUENCE_MAX) {
      lastTimestamp += 1;
      timestamp = lastTimestamp;
      sequence = 0;
    }
  } else if (timestamp > lastTimestamp) {
    lastTimestamp = timestamp;
    sequence = randomBytes(1)[0] & SEQUENCE_SEED_MASK;
  } else {
    // The clock moved backwards (NTP correction): keep issuing from the last
    // timestamp so ordering never regresses.
    timestamp = lastTimestamp;
    sequence += 1;
  }

  const bytes = randomBytes(16);

  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble, then the 12-bit counter.
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;

  // RFC 4122 variant (10xx) in the top two bits.
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
