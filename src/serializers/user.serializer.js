export const toPublicUser = (user) => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  username: user.username,
  createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : undefined,
});
