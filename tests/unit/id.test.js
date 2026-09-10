import { describe, expect, it } from 'vitest';
import { uuid, uuidV7 } from '../../src/utils/id.js';
import { PATTERNS } from '../../src/validators/rules.js';

describe('Identifier generation', () => {
  it('produces well-formed UUIDs', () => {
    expect(uuid()).toMatch(PATTERNS.UUID);
    expect(uuidV7()).toMatch(PATTERNS.UUID);
  });

  it('marks time-ordered ids as version 7', () => {
    expect(uuidV7()[14]).toBe('7');
  });

  it('keeps ids unique', () => {
    const ids = Array.from({ length: 10_000 }, uuidV7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts lexicographically in creation order, even within one millisecond', () => {
    // The whole point of v7 here: `_id` is the tiebreaker when several
    // messages share a `createdAt`, so it has to be monotonic.
    const ids = Array.from({ length: 5_000 }, uuidV7);
    expect([...ids].sort()).toEqual(ids);
  });

  it('encodes the current time in the leading bits', () => {
    const before = Date.now();
    const timestamp = Number.parseInt(uuidV7().replace(/-/g, '').slice(0, 12), 16);

    expect(timestamp).toBeGreaterThanOrEqual(before - 1000);
    expect(timestamp).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
