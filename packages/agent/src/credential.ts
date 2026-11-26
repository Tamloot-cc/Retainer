/**
 * The turn token, held so that nothing Mastra serializes can carry it: a
 * request context entry Mastra snapshots or puts in a span sees only
 * "[redacted]" (spec §7.3). Read it with `reveal()` when calling the API.
 */
export class TurnCredential {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  reveal(): string {
    return this.#token;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'TurnCredential [redacted]';
  }
}

export const TURN_CREDENTIAL_KEY = 'retainer.turn';
