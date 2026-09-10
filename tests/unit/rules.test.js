import { describe, expect, it } from 'vitest';
import { PATTERNS } from '../../src/validators/rules.js';
import { createChannelPayloadSchema } from '../../src/validators/channel.validator.js';
import { registerSchema } from '../../src/validators/auth.validator.js';

describe('Validation rules', () => {
  describe('username pattern', () => {
    it.each(['john', 'john123', 'user_name', 'a_b', 'My.Name-1'])('accepts %s', (username) => {
      expect(PATTERNS.USERNAME.test(username)).toBe(true);
    });

    it.each(['12john', 'jo', 'john doe', '', ' john', 'john ', 'john!', 'a'.repeat(25)])(
      'rejects %s',
      (username) => {
        expect(PATTERNS.USERNAME.test(username)).toBe(false);
      },
    );
  });

  describe('channel name pattern', () => {
    it.each(['general', 'gaming', 'room123', 'my-channel', 'a'])('accepts %s', (name) => {
      expect(PATTERNS.CHANNEL_NAME.test(name)).toBe(true);
    });

    it.each(['123room', 'my room', 'this-channel-name-is-too-long', '', 'my#channel'])(
      'rejects %s',
      (name) => {
        expect(PATTERNS.CHANNEL_NAME.test(name)).toBe(false);
      },
    );

    it('accepts a name of exactly 20 characters and rejects 21', () => {
      expect(PATTERNS.CHANNEL_NAME.test('a'.repeat(20))).toBe(true);
      expect(PATTERNS.CHANNEL_NAME.test('a'.repeat(21))).toBe(false);
    });
  });

  describe('registration schema', () => {
    it('trims surrounding whitespace from names', () => {
      const result = registerSchema.parse({
        body: { firstName: '  John ', lastName: ' Doe ', username: ' john ', password: 'sup3r-secret' },
      });

      expect(result.body).toMatchObject({ firstName: 'John', lastName: 'Doe', username: 'john' });
    });
  });

  describe('create channel schema', () => {
    it('defaults to a public channel', () => {
      expect(createChannelPayloadSchema.parse({ durationMinutes: 10 }).type).toBe('public');
    });

    it('treats an empty name as "generate one for me"', () => {
      expect(createChannelPayloadSchema.parse({ name: '', durationMinutes: 10 }).name).toBeUndefined();
    });

    it('requires a password for a private channel', () => {
      const result = createChannelPayloadSchema.safeParse({ type: 'private', durationMinutes: 10 });

      expect(result.success).toBe(false);
      expect(result.error.issues[0].path).toEqual(['password']);
    });

    it('refuses a password on a public channel', () => {
      const result = createChannelPayloadSchema.safeParse({
        type: 'public',
        password: 'sup3r-channel-pw',
        durationMinutes: 10,
      });

      expect(result.success).toBe(false);
    });

    it.each([0, 61, -1, 1.5])('rejects a duration of %s minutes', (durationMinutes) => {
      expect(createChannelPayloadSchema.safeParse({ durationMinutes }).success).toBe(false);
    });

    it.each([1, 30, 60])('accepts a duration of %s minutes', (durationMinutes) => {
      expect(createChannelPayloadSchema.safeParse({ durationMinutes }).success).toBe(true);
    });
  });
});
