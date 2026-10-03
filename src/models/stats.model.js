import mongoose from 'mongoose';

/**
 * All-time counters. They only ever go up: channels and messages are deleted
 * when a channel expires, so counting the live collections would undercount.
 */
const statsSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    channelsCreated: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
  },
  { versionKey: false, collection: 'stats' },
);

export const Stats = mongoose.model('Stats', statsSchema);
