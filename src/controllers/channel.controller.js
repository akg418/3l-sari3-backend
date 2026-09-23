import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';

export class ChannelController {
  constructor({ channelService, presenceReader }) {
    this.channelService = channelService;
    // Supplied by the realtime layer once it is attached; absent in tests that
    // exercise the HTTP API on its own, where everyone is simply offline.
    this.presenceReader = presenceReader;
  }

  list = asyncHandler(async (req, res) => {
    const { search, owner, type, limit, beforeCreatedAt, beforeId } = req.validated.query;

    const result = await this.channelService.listActiveChannels({
      userId: req.user.id,
      search,
      owner,
      type,
      limit,
      before: beforeCreatedAt ? { createdAt: beforeCreatedAt, id: beforeId } : undefined,
    });

    sendSuccess(res, result);
  });

  listMine = asyncHandler(async (req, res) => {
    const [channels, quota] = await Promise.all([
      this.channelService.listMyChannels(req.user.id),
      this.channelService.getChannelQuota(req.user.id),
    ]);
    sendSuccess(res, { channels, quota });
  });

  create = asyncHandler(async (req, res) => {
    const channel = await this.channelService.createChannel(req.validated.body, req.user);
    sendSuccess(res, { channel }, { status: 201 });
  });

  /** The caller's own channel allowance, so the UI can warn before they try. */
  quota = asyncHandler(async (req, res) => {
    sendSuccess(res, { quota: await this.channelService.getChannelQuota(req.user.id) });
  });

  get = asyncHandler(async (req, res) => {
    const channel = await this.channelService.getChannelForUser(
      req.validated.params.channelRef,
      req.user.id,
    );
    sendSuccess(res, { channel });
  });

  /**
   * The roster. Members only - who is in a channel is not public information,
   * least of all for a private one.
   */
  members = asyncHandler(async (req, res) => {
    const { channelRef } = req.validated.params;
    const channel = await this.channelService.assertMembership(channelRef, req.user.id);

    const members = await this.channelService.listMembers(channel.id, {
      onlineUserIds: this.presenceReader?.onlineUserIds(channel.id) ?? new Set(),
    });

    sendSuccess(res, { channelId: channel.id, members });
  });

  join = asyncHandler(async (req, res) => {
    const channel = await this.channelService.joinChannel(
      {
        channelRef: req.validated.params.channelRef,
        password: req.validated.body.password,
      },
      req.user,
    );
    sendSuccess(res, { channel });
  });

  /** HTTP twin of the `channel:read` socket event. */
  markRead = asyncHandler(async (req, res) => {
    const result = await this.channelService.markChannelRead(
      { channelRef: req.validated.params.channelRef },
      req.user,
    );
    sendSuccess(res, result);
  });

  leave = asyncHandler(async (req, res) => {
    const result = await this.channelService.leaveChannel(
      { channelRef: req.validated.params.channelRef },
      req.user,
    );
    sendSuccess(res, result);
  });
}
