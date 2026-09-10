import { ERROR_CODES } from '../constants/errorCodes.js';
import { conflict, notFound, unauthorized } from '../utils/AppError.js';

export class AuthService {
  constructor({ userRepository, passwordService, tokenService }) {
    this.userRepository = userRepository;
    this.passwordService = passwordService;
    this.tokenService = tokenService;
  }

  async register({ firstName, lastName, username, password }) {
    const usernameKey = username.toLowerCase();

    if (await this.userRepository.existsByUsernameKey(usernameKey)) {
      throw conflict(ERROR_CODES.USERNAME_TAKEN, 'That username is already taken.');
    }

    const passwordHash = await this.passwordService.hash(password);

    let user;
    try {
      user = await this.userRepository.create({
        firstName,
        lastName,
        username,
        usernameKey,
        passwordHash,
      });
    } catch (error) {
      // Two simultaneous registrations: the unique index is the real arbiter.
      if (this.userRepository.isDuplicateUsername(error)) {
        throw conflict(ERROR_CODES.USERNAME_TAKEN, 'That username is already taken.');
      }
      throw error;
    }

    return this.#authenticatedPayload(user);
  }

  async login({ username, password }) {
    const user = await this.userRepository.findByUsernameKeyWithSecret(username.toLowerCase());

    // Same error for "no such user" and "wrong password" - no user enumeration.
    // The hash comparison still runs so timing does not leak existence either.
    const passwordMatches = await this.passwordService.compare(
      password,
      user?.passwordHash ?? this.passwordService.dummyHash,
    );

    if (!user || !passwordMatches) {
      throw unauthorized('Incorrect username or password.', ERROR_CODES.INVALID_CREDENTIALS);
    }

    const { passwordHash: _ignored, ...publicUser } = user;
    return this.#authenticatedPayload(publicUser);
  }

  /** Resolves the current user from a token's claims. */
  async getUserById(userId) {
    const user = await this.userRepository.findById(userId);
    if (!user) throw notFound(ERROR_CODES.NOT_FOUND, 'User account no longer exists.');
    return user;
  }

  #authenticatedPayload(user) {
    const { token, expiresAt } = this.tokenService.issueAccessToken(user);
    return { user, token, expiresAt };
  }
}
