/**
 * A single response envelope for the whole API.
 *
 * `meta.serverTime` lets the client measure its clock offset against the
 * server on every request, so countdowns never depend on the client clock.
 */
export const buildMeta = (extra = {}) => ({
  serverTime: new Date().toISOString(),
  ...extra,
});

export const sendSuccess = (res, data, { status = 200, meta } = {}) =>
  res.status(status).json({
    success: true,
    data,
    meta: buildMeta(meta),
  });

export const sendError = (res, error, { status = 400, meta } = {}) =>
  res.status(status).json({
    success: false,
    error,
    meta: buildMeta(meta),
  });
