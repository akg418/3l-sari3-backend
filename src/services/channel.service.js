import { randomInt } from 'node:crypto';
import { CHANNEL_TYPES, LIMITS } from '../constants/domain.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { DOMAIN_EVENTS } from '../utils/domainEvents.js';
import { addMinutes, isExpired } from '../utils/time.js';
import { isUuid } from '../utils/id.js';
import { conflict, forbidden, notFound, validationError } from '../utils/AppError.js';
import {
  toDirectoryChannel,
  toPublicChannel,
  toPublicChannelList,
} from '../serializers/channel.serializer.js';
import { sortMembers, toPublicMember } from '../serializers/member.serializer.js';

const GENERATED_NAME_ATTEMPTS = 5;

export class ChannelService {
  constructor({
    channelRepository,
    membershipRepository,
    messageRepository,
    userRepository,
    passwordService,
    eventBus,
    config,
  }) {
    this.channelRepository = channelRepository;
    this.membershipRepository = membershipRepository;
    this.messageRepository = messageRepository;
    this.userRepository = userRepository;
    this.passwordService = passwordService;
    this.eventBus = eventBus;
    this.config = config;
  }

  // ---------------------------------------------------------------- creation

  async createChannel({ name, type, password, durationMinutes }, actor) {
    if (type === CHANNEL_TYPES.PRIVATE && !password) {
      throw validationError(
        [{ field: 'password', message: 'A private channel requires a password.' }],
        'A private channel requires a password.',
      );
    }

    await this.#assertChannelQuota(actor.id);

    const passwordHash =
      type === CHANNEL_TYPES.PRIVATE ? await this.passwordService.hash(password) : null;

    const createdAt = new Date();
    const expiresAt = addMinutes(createdAt, durationMinutes);
    const attributes = { type, passwordHash, durationMinutes, createdAt, expiresAt };

    const channel = await this.#createInFreeSlot({ attributes, name }, actor);

    await this.membershipRepository.join({
      channelId: channel.id,
      userId: actor.id,
      expiresAt: channel.expiresAt,
    });

    const publicChannel = toPublicChannel(channel, {
      memberCount: 1,
      isMember: true,
      viewerId: actor.id,
    });

    // The event goes to everyone, so it carries no answer to "am I a member?" -
    // that question has a different answer for each recipient.
    this.eventBus.emit(DOMAIN_EVENTS.CHANNEL_CREATED, {
      channel: toDirectoryChannel(publicChannel),
      actor,
    });

    return publicChannel;
  }

  /**
   * The per-user cap counts only channels this user *owns* and that are still
   * live, so joining other people's channels is never limited and an expired
   * channel frees its slot automatically.
   */
  async #assertChannelQuota(userId) {
    const owned = await this.channelRepository.countOwnedChannels(userId);
    if (owned + 1 <= this.config.maxActivePerUser) return;
    throw this.#limitReached();
  }

  /**
   * Creates the channel in one of its owner's free allowance slots.
   *
   * The count above is the friendly check; *this* is the enforcement. A unique
   * index on `(createdBy, ownerSlot)` means two live channels can never share
   * a slot, so N slots is a hard ceiling of N channels however many requests
   * race. A loser gets a duplicate-key error and simply tries the next slot;
   * when every slot rejects it, the user genuinely has no room.
   *
   * Application-side counting cannot achieve this on its own: concurrent
   * requests all read the same total and all conclude they may proceed.
   */
  async #createInFreeSlot({ attributes, name }, actor) {
    const occupied = new Set(await this.channelRepository.listOccupiedSlots(actor.id));

    for (let ownerSlot = 1; ownerSlot <= this.config.maxActivePerUser; ownerSlot += 1) {
      if (occupied.has(ownerSlot)) continue;

      try {
        const payload = { ...attributes, ownerSlot };
        return name
          ? await this.#createWithName({ ...payload, name }, actor)
          : await this.#createWithGeneratedName(payload, actor);
      } catch (error) {
        // Somebody else took this slot in the meantime; try the next one.
        if (this.channelRepository.isDuplicateOwnerSlot(error)) continue;
        throw error;
      }
    }

    throw this.#limitReached();
  }

  #limitReached() {
    const limit = this.config.maxActivePerUser;
    return conflict(
      ERROR_CODES.CHANNEL_LIMIT_REACHED,
      `You can have at most ${limit} active channels at a time. Wait for one to expire, or delete one, and try again.`,
    );
  }

  /**
   * The caller's allowance. `used` counts channels that still exist, matching
   * what the cap actually enforces - so the UI never promises a slot the API
   * would refuse.
   */
  async getChannelQuota(userId) {
    const used = await this.channelRepository.countOwnedChannels(userId);
    const limit = this.config.maxActivePerUser;
    return { used, limit, remaining: Math.max(0, limit - used), canCreate: used < limit };
  }

  // --------------------------------------------------------------- retrieval

  /**
   * Resolves whatever a client used to name a channel - its UUID or its unique
   * name - to the stored channel.
   *
   * Names are the public, URL-facing identifier; ids remain canonical inside
   * the system. Accepting both here means routing, the realtime layer and the
   * API do not each need their own lookup, and a bookmarked name keeps working.
   */
  async #findByRef(ref, { withSecret = false } = {}) {
    if (isUuid(ref)) {
      return withSecret
        ? this.channelRepository.findByIdWithSecret(ref)
        : this.channelRepository.findById(ref);
    }

    const nameKey = String(ref ?? '').toLowerCase();
    return withSecret
      ? this.channelRepository.findByNameKeyWithSecret(nameKey)
      : this.channelRepository.findByNameKey(nameKey);
  }

  /**
   * Loads a channel that is guaranteed to still be alive.
   *
   * Every read path goes through here, so a client holding a stale directory
   * can never act on an expired channel - including in the window before the
   * sweeper has deleted it.
   */
  async getActiveChannelOrFail(ref, { withSecret = false } = {}) {
    const channel = await this.#findByRef(ref, { withSecret });

    if (!channel) {
      throw notFound(ERROR_CODES.CHANNEL_NOT_FOUND, 'This channel does not exist.');
    }
    if (isExpired(channel.expiresAt)) {
      throw notFound(ERROR_CODES.CHANNEL_EXPIRED, 'This channel has expired.');
    }
    return channel;
  }

  async getChannelForUser(ref, userId) {
    const channel = await this.getActiveChannelOrFail(ref);
    const [memberCounts, isMember] = await Promise.all([
      this.membershipRepository.countByChannelIds([channel.id]),
      this.membershipRepository.exists({ channelId: channel.id, userId }),
    ]);

    return toPublicChannel(channel, {
      memberCount: memberCounts.get(channel.id) ?? 0,
      isMember,
      viewerId: userId,
    });
  }

  /**
   * The public directory: one page of live channels, newest first.
   *
   * Search and the two filters are applied by the database rather than the
   * client, because with paging a client can only filter what it happens to
   * have already fetched.
   */
  async listActiveChannels({ userId, search, owner, type, limit, before } = {}) {
    const pageSize = Math.min(limit ?? LIMITS.CHANNEL_PAGE_SIZE, LIMITS.CHANNEL_PAGE_SIZE_MAX);

    // One extra row answers "is there another page?" without a second count.
    const found = await this.channelRepository.listActive({
      search,
      owner,
      type,
      before,
      limit: pageSize + 1,
    });

    const hasMore = found.length > pageSize;
    const channels = hasMore ? found.slice(0, pageSize) : found;
    const oldest = channels.at(-1);

    const [memberCounts, myChannelIds] = await Promise.all([
      this.membershipRepository.countByChannelIds(channels.map((channel) => channel.id)),
      userId ? this.membershipRepository.listChannelIdsByUser(userId) : Promise.resolve([]),
    ]);

    return {
      channels: toPublicChannelList(channels, {
        memberCounts,
        memberChannelIds: new Set(myChannelIds),
        viewerId: userId,
      }),
      pageInfo: {
        hasMore,
        nextCursor: hasMore && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
      },
    };
  }

  /**
   * "My channels" is exactly the channels this user has joined - public or
   * private, created by them or by someone else.
   *
   * Membership is the only criterion. Creating a channel joins it, so a
   * channel you made appears here; leaving one removes it, even if you own it.
   * An owner who leaves is not locked out - they can rejoin from the directory
   * without the password - but until they do, they are not in it.
   */
  async listMyChannels(userId) {
    const memberships = await this.membershipRepository.listByUser(userId);
    if (memberships.length === 0) return [];

    const joinedIds = memberships.map((membership) => membership.channelId);
    const channels = await this.channelRepository.listActive({ ids: joinedIds });

    const [memberCounts, unreadCounts] = await Promise.all([
      this.membershipRepository.countByChannelIds(channels.map((channel) => channel.id)),
      this.messageRepository.countUnreadByChannel({ memberships, userId }),
    ]);

    return channels.map((channel) =>
      toPublicChannel(channel, {
        memberCount: memberCounts.get(channel.id) ?? 0,
        unreadCount: unreadCounts.get(channel.id) ?? 0,
        isMember: true,
        viewerId: userId,
      }),
    );
  }

  /**
   * Marks a channel as read up to now.
   *
   * The cutoff only ever moves forward, so a replayed or out-of-order
   * acknowledgement cannot make read messages unread again.
   */
  async markChannelRead({ channelId, channelRef }, actor) {
    const channel = await this.assertMembership(channelRef ?? channelId, actor.id);
    const at = new Date();

    await this.membershipRepository.markRead({
      channelId: channel.id,
      userId: actor.id,
      at,
    });

    return { channelId: channel.id, readAt: at.toISOString() };
  }

  // ----------------------------------------------------------------- joining

  async joinChannel({ channelId, channelRef, password }, actor) {
    const channel = await this.getActiveChannelOrFail(channelRef ?? channelId, { withSecret: true });

    if (channel.type === CHANNEL_TYPES.PRIVATE) {
      await this.#assertPrivateChannelAccess(channel, { password, actor });
    }

    await this.membershipRepository.join({
      channelId: channel.id,
      userId: actor.id,
      expiresAt: channel.expiresAt,
    });

    const memberCounts = await this.membershipRepository.countByChannelIds([channel.id]);
    const publicChannel = toPublicChannel(channel, {
      memberCount: memberCounts.get(channel.id) ?? 1,
      isMember: true,
      viewerId: actor.id,
    });

    this.eventBus.emit(DOMAIN_EVENTS.CHANNEL_MEMBER_JOINED, { channel: publicChannel, actor });
    return publicChannel;
  }

  /**
   * The gate on a private channel. Three ways through, in this order:
   *
   *  - the owner, who chose the password and must never be locked out of their
   *    own channel;
   *  - an existing member, so a reconnect or a page refresh does not re-prompt;
   *  - anyone else, with the correct password, verified here and nowhere else.
   */
  async #assertPrivateChannelAccess(channel, { password, actor }) {
    // The owner is always a member, since they cannot leave - so this is a
    // safety net rather than a normal path, and it costs one comparison.
    if (channel.createdBy === actor.id) return;

    const alreadyMember = await this.membershipRepository.exists({
      channelId: channel.id,
      userId: actor.id,
    });
    if (alreadyMember) return;

    if (!password) {
      throw forbidden(
        ERROR_CODES.CHANNEL_PASSWORD_REQUIRED,
        'This channel is private. A password is required.',
      );
    }

    const matches = await this.passwordService.compare(password, channel.passwordHash);
    if (!matches) {
      throw forbidden(ERROR_CODES.CHANNEL_PASSWORD_INVALID, 'Incorrect channel password.');
    }
  }

  async leaveChannel({ channelId, channelRef }, actor) {
    const channel = await this.getActiveChannelOrFail(channelRef ?? channelId);

    /**
     * The creator cannot leave.
     *
     * A channel with no owner present is a worse state than one you have to
     * wait out: it is theirs, it counts against their allowance, and they are
     * the only one who knows a private channel's password. Since it deletes
     * itself within the hour, leaving is a need the design does not really
     * have - and refusing keeps ownership and membership from ever diverging.
     */
    if (channel.createdBy === actor.id) {
      throw forbidden(
        ERROR_CODES.CHANNEL_OWNER_CANNOT_LEAVE,
        'You created this channel, so you cannot leave it. It will disappear on its own when it expires.',
      );
    }

    const left = await this.membershipRepository.leave({
      channelId: channel.id,
      userId: actor.id,
    });

    if (left) {
      this.eventBus.emit(DOMAIN_EVENTS.CHANNEL_MEMBER_LEFT, { channelId: channel.id, actor });
    }
    return { channelId: channel.id, left };
  }

  // ----------------------------------------------------------- authorisation

  /**
   * The single authorisation gate for taking part in a channel, shared by the
   * REST and WebSocket paths so a rule cannot be enforced on one and forgotten
   * on the other. Returns the channel, since callers invariably need it.
   */
  async assertMembership(ref, userId) {
    const channel = await this.getActiveChannelOrFail(ref);

    // No exception for the owner: creating a channel joins it, and leaving it
    // means leaving it. Ownership only exempts them from the password when
    // they come back - it never substitutes for being a member.
    const isMember = await this.membershipRepository.exists({
      channelId: channel.id,
      userId,
    });
    if (!isMember) {
      throw forbidden(
        ERROR_CODES.CHANNEL_NOT_JOINED,
        'You must join this channel before you can take part in it.',
      );
    }
    return channel;
  }

  // ----------------------------------------------------------------- members

  listMemberIds(channelId) {
    return this.membershipRepository.listUserIdsByChannel(channelId);
  }

  /**
   * The channel roster, with live presence folded in.
   *
   * `onlineUserIds` comes from the realtime layer - it knows which sockets are
   * currently subscribed - and is passed in rather than looked up, so this
   * service stays free of transport concerns.
   *
   * Accepts a name or an id, like every other channel-addressed method.
   */
  async listMembers(ref, { onlineUserIds = new Set() } = {}) {
    const channel = await this.getActiveChannelOrFail(ref);
    const channelId = channel.id;
    const memberships = await this.membershipRepository.listByChannel(channelId);
    const ownerId = channel.createdBy;

    // Only actual members. An owner who left is not in the channel, so they
    // are not on its roster either.
    const userIds = memberships.map((entry) => entry.userId);
    const users = await this.userRepository.findManyByIds(userIds);
    const joinedAtById = new Map(memberships.map((entry) => [entry.userId, entry.joinedAt]));

    const members = users.map((user) =>
      toPublicMember({
        user,
        joinedAt: joinedAtById.get(user.id),
        isOwner: user.id === ownerId,
        isOnline: onlineUserIds.has(user.id),
      }),
    );

    return sortMembers(members);
  }

  // ---------------------------------------------------------- name creation

  async #createWithName(payload, actor) {
    const nameKey = payload.name.toLowerCase();

    if (await this.channelRepository.existsByNameKey(nameKey)) {
      throw conflict(ERROR_CODES.CHANNEL_NAME_TAKEN, 'A channel with this name already exists.');
    }

    try {
      return await this.#persist({ ...payload, nameKey }, actor);
    } catch (error) {
      if (this.channelRepository.isDuplicateName(error)) {
        throw conflict(ERROR_CODES.CHANNEL_NAME_TAKEN, 'A channel with this name already exists.');
      }
      throw error;
    }
  }

  async #createWithGeneratedName(payload, actor) {
    for (let attempt = 0; attempt < GENERATED_NAME_ATTEMPTS; attempt += 1) {
      const name = `channel_${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      try {
        return await this.#persist({ ...payload, name, nameKey: name.toLowerCase() }, actor);
      } catch (error) {
        if (this.channelRepository.isDuplicateName(error)) continue;
        throw error;
      }
    }
    throw conflict(
      ERROR_CODES.CHANNEL_NAME_TAKEN,
      'Could not allocate a channel name. Please try again.',
    );
  }

  #persist(
    { name, nameKey, type, passwordHash, durationMinutes, createdAt, expiresAt, ownerSlot },
    actor,
  ) {
    return this.channelRepository.create({
      name,
      nameKey,
      type,
      passwordHash,
      durationMinutes,
      createdAt,
      expiresAt,
      ownerSlot,
      createdBy: actor.id,
      createdByUsername: actor.username,
    });
  }
}
