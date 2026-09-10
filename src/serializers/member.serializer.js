/**
 * What a client may know about a fellow member.
 *
 * `isOnline` reflects whether that person currently has a socket subscribed to
 * the channel - live presence - while membership itself is what the database
 * records. The two are deliberately distinct, and both are shown.
 */
export const toPublicMember = ({ user, joinedAt, isOwner = false, isOnline = false }) => ({
  id: user.id,
  username: user.username,
  displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username,
  joinedAt: joinedAt ? new Date(joinedAt).toISOString() : null,
  isOwner,
  isOnline,
});

export const sortMembers = (members) =>
  [...members].sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
