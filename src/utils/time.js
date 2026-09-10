export const MINUTE_MS = 60_000;

export const now = () => new Date();

export const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * MINUTE_MS);

export const msUntil = (date, from = Date.now()) => new Date(date).getTime() - from;

export const isExpired = (date, at = Date.now()) => new Date(date).getTime() <= at;
