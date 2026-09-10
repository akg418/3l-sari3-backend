import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clearTestDatabase,
  setupTestDatabase,
  teardownTestDatabase,
} from '../helpers/database.js';
import { buildTestHarness, registerUser, uniqueUsername } from '../helpers/testApp.js';

describe('Authentication', () => {
  let api;

  beforeAll(async () => {
    await setupTestDatabase();
    api = buildTestHarness().api;
  });

  afterEach(clearTestDatabase);
  afterAll(teardownTestDatabase);

  describe('POST /api/auth/register', () => {
    it('registers a user, returns a token and never returns the password', async () => {
      const username = uniqueUsername('john');
      const response = await api
        .post('/api/auth/register')
        .send({ firstName: 'John', lastName: 'Doe', username, password: 'sup3r-secret' })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user).toMatchObject({ username, firstName: 'John' });
      expect(response.body.data.token).toBeTypeOf('string');
      expect(response.body.meta.serverTime).toBeTypeOf('string');

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('sup3r-secret');
    });

    it('issues a UUID as the user id, not an ObjectId', async () => {
      const { user } = await registerUser(api);
      expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('rejects a duplicate username', async () => {
      const username = uniqueUsername('taken');
      await registerUser(api, { username });

      const response = await api
        .post('/api/auth/register')
        .send({ firstName: 'A', lastName: 'B', username, password: 'sup3r-secret' })
        .expect(409);

      expect(response.body.error.code).toBe('USERNAME_TAKEN');
    });

    it('treats usernames as case insensitive for uniqueness', async () => {
      await registerUser(api, { username: 'CaseSensitive' });

      const response = await api
        .post('/api/auth/register')
        .send({ firstName: 'A', lastName: 'B', username: 'casesensitive', password: 'sup3r-secret' })
        .expect(409);

      expect(response.body.error.code).toBe('USERNAME_TAKEN');
    });

    it.each([
      ['starts with a number', '12john'],
      ['is too short', 'jo'],
      ['contains a space', 'john doe'],
      ['is empty', ''],
      ['contains illegal characters', 'john!doe'],
    ])('rejects a username that %s', async (_label, username) => {
      const response = await api
        .post('/api/auth/register')
        .send({ firstName: 'John', lastName: 'Doe', username, password: 'sup3r-secret' })
        .expect(422);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.some((detail) => detail.field === 'username')).toBe(true);
    });

    it.each([
      ['john', 'valid lowercase'],
      ['john123', 'digits after the first character'],
      ['user_name', 'underscores'],
      ['my.name-1', 'dots and dashes'],
    ])('accepts "%s" (%s)', async (username) => {
      await api
        .post('/api/auth/register')
        .send({ firstName: 'John', lastName: 'Doe', username, password: 'sup3r-secret' })
        .expect(201);
    });

    it('requires the mandatory profile fields', async () => {
      const response = await api.post('/api/auth/register').send({}).expect(422);
      const fields = response.body.error.details.map((detail) => detail.field);
      expect(fields).toEqual(expect.arrayContaining(['firstName', 'lastName', 'username', 'password']));
    });

    it('rejects a password shorter than 8 characters', async () => {
      const response = await api
        .post('/api/auth/register')
        .send({ firstName: 'J', lastName: 'D', username: uniqueUsername(), password: 'short' })
        .expect(422);

      expect(response.body.error.details[0].field).toBe('password');
    });
  });

  describe('POST /api/auth/login', () => {
    it('logs in with the correct credentials', async () => {
      const { payload } = await registerUser(api);

      const response = await api
        .post('/api/auth/login')
        .send({ username: payload.username, password: payload.password })
        .expect(200);

      expect(response.body.data.user.username).toBe(payload.username);
      expect(response.body.data.token).toBeTypeOf('string');
    });

    it('accepts a username in a different case', async () => {
      const { payload } = await registerUser(api, { username: 'MixedCase' });

      await api
        .post('/api/auth/login')
        .send({ username: 'mixedcase', password: payload.password })
        .expect(200);
    });

    it('rejects a wrong password', async () => {
      const { payload } = await registerUser(api);

      const response = await api
        .post('/api/auth/login')
        .send({ username: payload.username, password: 'not-the-password' })
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('does not reveal whether a username exists', async () => {
      const { payload } = await registerUser(api);

      const wrongPassword = await api
        .post('/api/auth/login')
        .send({ username: payload.username, password: 'wrong-password' })
        .expect(401);

      const unknownUser = await api
        .post('/api/auth/login')
        .send({ username: 'nobody_here', password: 'wrong-password' })
        .expect(401);

      expect(unknownUser.body.error).toEqual(wrongPassword.body.error);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the caller when a valid token is supplied', async () => {
      const { token, user } = await registerUser(api);

      const response = await api.get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(response.body.data.user.id).toBe(user.id);
    });

    it.each([
      ['no token', undefined, 'UNAUTHORIZED'],
      ['a malformed header', 'Token abc', 'UNAUTHORIZED'],
      ['a forged token', 'Bearer not.a.jwt', 'TOKEN_INVALID'],
    ])('rejects a request with %s', async (_label, header, expectedCode) => {
      const req = api.get('/api/auth/me');
      if (header) req.set('Authorization', header);

      const response = await req.expect(401);
      expect(response.body.error.code).toBe(expectedCode);
    });
  });
});
