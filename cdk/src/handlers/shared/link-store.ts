/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * In-memory link store for a URL shortener.
 *
 * This is the storage layer that sits on top of the base62 short-code
 * primitive (``./short-code``). It does two things:
 *
 *   - ``save(url)`` — records a long URL and returns the short code that
 *     addresses it.
 *   - ``lookup(code)`` — resolves a short code back to the original URL (or
 *     ``undefined`` for a code that was never issued).
 *
 * Everything is held in process memory — there is no database, no AWS SDK, and
 * no persistence across restarts. That makes the store trivial to unit-test and
 * suitable as a reference / fixture implementation; a production shortener would
 * swap the in-memory maps for DynamoDB while keeping this same public shape.
 *
 * Design notes:
 *   - **Stable codes for repeated inputs.** Saving the exact same URL twice
 *     returns the exact same code. The store keeps a URL → code index so a
 *     duplicate ``save`` is idempotent and never burns a fresh id. This keeps
 *     the code space compact and lets callers treat ``save`` as "get or create".
 *   - **Monotonic ids.** New URLs are assigned an incrementing ``bigint`` id
 *     starting at ``0``, which is encoded to base62 for the code. ``bigint``
 *     matches ``short-code`` and means the id space never overflows.
 *   - **Codes are opaque.** Callers should treat the returned code as a token,
 *     not parse it. The encoding is an implementation detail of this store.
 */

import { decodeBase62, encodeBase62 } from './short-code';

/** The public storage contract, so callers can depend on the shape rather than
 *  the concrete class (and swap in a DynamoDB-backed impl later). */
export interface LinkStore {
  /** The number of distinct URLs currently stored. */
  readonly size: number;

  /**
   * Save a long URL and return the short code that addresses it.
   *
   * Idempotent: saving the same URL again returns the same code it was first
   * given, without allocating a new id.
   */
  save(url: string): string;

  /**
   * Resolve a short code back to the original URL.
   *
   * @returns The original URL, or ``undefined`` if the code was never issued.
   */
  lookup(code: string): string | undefined;
}

/**
 * An in-memory {@link LinkStore}. Not safe for use across processes and not
 * persisted — state lives only for the lifetime of the instance.
 */
export class InMemoryLinkStore implements LinkStore {
  /** code → original URL. The forward lookup used by {@link lookup}. */
  private readonly codeToUrl = new Map<string, string>();

  /** URL → code. The reverse index that makes {@link save} idempotent. */
  private readonly urlToCode = new Map<string, string>();

  /** The next numeric id to allocate. Encoded to base62 to form the code. */
  private nextId = 0n;

  /** The number of distinct URLs currently stored. */
  get size(): number {
    return this.codeToUrl.size;
  }

  /**
   * Save a long URL and return its short code.
   *
   * @param url - A non-empty URL string to shorten.
   * @returns The base62 short code for this URL — the same code on every call
   *   for a given URL.
   * @throws {TypeError} if ``url`` is not a string.
   * @throws {RangeError} if ``url`` is an empty string.
   */
  save(url: string): string {
    if (typeof url !== 'string') {
      throw new TypeError(`InMemoryLinkStore.save: url must be a string, received ${typeof url}`);
    }
    if (url.length === 0) {
      throw new RangeError('InMemoryLinkStore.save: url must be a non-empty string');
    }

    // Stable codes: a URL we've already stored keeps its original code.
    const existing = this.urlToCode.get(url);
    if (existing !== undefined) {
      return existing;
    }

    const code = encodeBase62(this.nextId);
    this.nextId += 1n;
    this.codeToUrl.set(code, url);
    this.urlToCode.set(url, code);
    return code;
  }

  /**
   * Resolve a short code back to the original URL.
   *
   * @param code - A short code previously returned by {@link save}.
   * @returns The original URL, or ``undefined`` for an unknown code. Unknown
   *   codes (including malformed ones) never throw — resolution is a lookup, not
   *   a validation.
   */
  lookup(code: string): string | undefined {
    if (typeof code !== 'string') {
      return undefined;
    }
    return this.codeToUrl.get(code);
  }
}

/**
 * Convenience re-export so callers that hold a code can recover its numeric id
 * without reaching into ``./short-code`` directly. Kept thin on purpose — the
 * store owns the id space, ``short-code`` owns the encoding.
 */
export function idForCode(code: string): bigint {
  return decodeBase62(code);
}
