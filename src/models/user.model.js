import mongoose from 'mongoose';
import { uuidPrimaryKey } from './plugins/uuidPrimaryKey.js';
import { LIMITS } from '../constants/domain.js';

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: LIMITS.NAME_MAX },
    lastName: { type: String, required: true, trim: true, maxlength: LIMITS.NAME_MAX },

    /** Display form, exactly as the user typed it. */
    username: { type: String, required: true, trim: true, maxlength: LIMITS.USERNAME_MAX },

    /**
     * Lower-cased lookup key. Uniqueness is enforced on this field so that
     * "John" and "john" cannot both exist.
     */
    usernameKey: { type: String, required: true, lowercase: true, trim: true },

    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.plugin(uuidPrimaryKey, { hidden: ['passwordHash', 'usernameKey'] });

userSchema.index({ usernameKey: 1 }, { unique: true, name: 'uniq_username_key' });

export const User = mongoose.model('User', userSchema);
