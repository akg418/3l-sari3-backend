import { z } from 'zod';
import { accountPasswordField, personNameField, usernameField } from './rules.js';

export const registerSchema = z.object({
  body: z.object({
    firstName: personNameField('First name'),
    lastName: personNameField('Last name'),
    username: usernameField,
    password: accountPasswordField,
  }),
});

export const loginSchema = z.object({
  body: z.object({
    // Login must not leak the username rules, so only presence is checked here.
    username: z.string({ required_error: 'Username is required.' }).trim().min(1, 'Username is required.'),
    password: z.string({ required_error: 'Password is required.' }).min(1, 'Password is required.'),
  }),
});
