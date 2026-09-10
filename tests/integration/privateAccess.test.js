import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTestDatabase, setupTestDatabase, teardownTestDatabase } from '../helpers/database.js';
import { buildTestHarness, createChannel, registerUser } from '../helpers/testApp.js';

const PASSWORD = 'sup3r-channel-pw';

describe('Private channel access', () => {
  let harness;
  let api;
  let owner;
  let channel;

  beforeAll(async () => {
    await setupTestDatabase();
    harness = buildTestHarness();
    api = harness.api;
  });

  beforeEach(async () => {
    owner = await registerUser(api);
    const created = await createChannel(api, owner.token, {
      name: 'vault',
      type: 'private',
      password: PASSWORD,
      durationMinutes: 30,
    });
    channel = created.body.data.channel;
  });

  afterEach(clearTestDatabase);

  afterAll(async () => {
    harness.cleanupStorage();
    await teardownTestDatabase();
  });

  const join = (token, body = {}) =>
    api.post(`/api/channels/vault/join`).set('Authorization', `Bearer ${token}`).send(body);

  it('never asks the owner for their own password', async () => {
    // They cannot leave, so they are always a member - and rejoining, which is
    // what a reconnect does, must not prompt them for the secret they set.
    const response = await join(owner.token);

    expect(response.status).toBe(200);
    expect(response.body.data.channel.isOwner).toBe(true);
  });

  it('will not let the owner leave their own private channel', async () => {
    const response = await api
      .post(`/api/channels/${channel.id}/leave`)
      .set('Authorization', owner.authHeader);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CHANNEL_OWNER_CANNOT_LEAVE');
  });

  it('requires the password from someone new', async () => {
    const guest = await registerUser(api);
    const response = await join(guest.token);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CHANNEL_PASSWORD_REQUIRED');
  });

  it('refuses an incorrect password with a clear code', async () => {
    const guest = await registerUser(api);
    const response = await join(guest.token, { password: 'not-the-password' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CHANNEL_PASSWORD_INVALID');
    expect(response.body.error.message).toBe('Incorrect channel password.');
  });

  it('admits someone with the correct password', async () => {
    const guest = await registerUser(api);
    const response = await join(guest.token, { password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.channel.isMember).toBe(true);
    expect(response.body.data.channel.isOwner).toBe(false);
  });

  it('does not ask an existing member again', async () => {
    const guest = await registerUser(api);
    await join(guest.token, { password: PASSWORD }).expect(200);

    // What a page refresh or a reconnect does.
    const response = await join(guest.token);
    expect(response.status).toBe(200);
  });

  it('keeps the password out of every response about the channel', async () => {
    const guest = await registerUser(api);
    await join(guest.token, { password: PASSWORD }).expect(200);

    const responses = await Promise.all([
      api.get('/api/channels').set('Authorization', guest.authHeader),
      api.get('/api/channels/mine').set('Authorization', guest.authHeader),
      api.get('/api/channels/vault').set('Authorization', guest.authHeader),
      api.get('/api/channels/vault/members').set('Authorization', guest.authHeader),
      api.get('/api/channels/vault/messages').set('Authorization', guest.authHeader),
    ]);

    for (const response of responses) {
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain('passwordHash');
    }
  });

  it('blocks a non-member from a private channel\'s content', async () => {
    const outsider = await registerUser(api);

    const messages = await api
      .get('/api/channels/vault/messages')
      .set('Authorization', outsider.authHeader);
    const members = await api
      .get('/api/channels/vault/members')
      .set('Authorization', outsider.authHeader);

    expect(messages.status).toBe(403);
    expect(members.status).toBe(403);
  });

  it('still shows a private channel in the directory, without a way in', async () => {
    const outsider = await registerUser(api);

    const response = await api
      .get('/api/channels')
      .set('Authorization', outsider.authHeader)
      .expect(200);

    const entry = response.body.data.channels.find((item) => item.name === 'vault');
    expect(entry).toMatchObject({ isPrivate: true, isMember: false, isOwner: false });
    expect(entry.password).toBeUndefined();
  });
});
