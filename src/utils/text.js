/**
 * Escapes a user-supplied string for literal use inside a regular expression.
 *
 * Search terms reach MongoDB as `$regex`, so an unescaped value would let a
 * caller inject pattern syntax - at best matching things they did not ask for,
 * at worst a catastrophically backtracking pattern aimed at the database.
 */
export const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
