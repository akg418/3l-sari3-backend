/** Forwards rejected promises from async route handlers to Express' error pipeline. */
export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
