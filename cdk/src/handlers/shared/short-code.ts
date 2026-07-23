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
 * Base62 short-code encoder / decoder.
 *
 * Turns a non-negative integer into a short, URL-friendly string using the
 * base62 alphabet (``0-9``, ``A-Z``, ``a-z``) and back again. This is the core
 * primitive behind a link shortener: a monotonically increasing numeric id is
 * encoded into the compact code that appears in the generated short link, and
 * the same code is later decoded back to the id for lookup.
 *
 * The module is intentionally self-contained — it has no dependencies on the
 * rest of the shortener (or any AWS SDK) so it can be unit-tested in isolation
 * and reused anywhere a compact, reversible id representation is needed.
 *
 * Design notes:
 *   - The alphabet order (digits, then upper-case, then lower-case) is a
 *     deliberate, stable contract. Changing it would invalidate every code
 *     already emitted, so treat it as append-only / frozen.
 *   - ``bigint`` is used for arithmetic so values beyond
 *     ``Number.MAX_SAFE_INTEGER`` (2^53 - 1) round-trip losslessly. The public
 *     API accepts a ``number`` or ``bigint`` on encode and always returns a
 *     ``bigint`` on decode; use ``Number(decoded)`` at the call site when the
 *     value is known to be small.
 */

/** The base62 alphabet. Order is a stable, frozen contract — see module docs. */
export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const BASE = BigInt(BASE62_ALPHABET.length); // 62n
const ZERO = BigInt(0);

/**
 * Reverse lookup from character → digit value, built once at module load.
 * Using a map keeps decode O(n) in the code length without repeated
 * ``indexOf`` scans of the alphabet.
 */
const CHAR_TO_VALUE: ReadonlyMap<string, bigint> = new Map(
  [...BASE62_ALPHABET].map((char, index) => [char, BigInt(index)] as const),
);

/**
 * Encode a non-negative integer into a base62 short code.
 *
 * @param value - A non-negative integer, as a ``number`` or ``bigint``. When a
 *   ``number`` is passed it must be a safe, non-negative integer
 *   (``Number.isSafeInteger``); pass a ``bigint`` for larger values.
 * @returns The base62 string. ``0`` encodes to ``"0"`` (never an empty string).
 * @throws {RangeError} if ``value`` is negative.
 * @throws {TypeError} if ``value`` is not an integer (or, for ``number``, not a
 *   safe integer / is ``NaN`` / ``Infinity``).
 */
export function encodeBase62(value: number | bigint): string {
  const n = normalizeInput(value);
  if (n < ZERO) {
    throw new RangeError(`encodeBase62: value must be non-negative, received ${value}`);
  }
  if (n === ZERO) {
    return BASE62_ALPHABET[0];
  }

  let remaining = n;
  let out = '';
  while (remaining > ZERO) {
    const digit = remaining % BASE;
    out = BASE62_ALPHABET[Number(digit)] + out;
    remaining /= BASE;
  }
  return out;
}

/**
 * Decode a base62 short code back into the integer it represents.
 *
 * @param code - A non-empty string containing only base62 alphabet characters.
 * @returns The decoded value as a ``bigint`` (use ``Number(...)`` when the
 *   value is known to fit in a JS number).
 * @throws {TypeError} if ``code`` is not a string.
 * @throws {RangeError} if ``code`` is empty or contains a character outside the
 *   base62 alphabet.
 */
export function decodeBase62(code: string): bigint {
  if (typeof code !== 'string') {
    throw new TypeError(`decodeBase62: code must be a string, received ${typeof code}`);
  }
  if (code.length === 0) {
    throw new RangeError('decodeBase62: code must be a non-empty string');
  }

  let result = ZERO;
  for (const char of code) {
    const digit = CHAR_TO_VALUE.get(char);
    if (digit === undefined) {
      throw new RangeError(
        `decodeBase62: invalid character ${JSON.stringify(char)} in code ${JSON.stringify(code)}`,
      );
    }
    result = result * BASE + digit;
  }
  return result;
}

/**
 * Coerce the ``encodeBase62`` input into a ``bigint``, rejecting values that
 * cannot represent an exact integer.
 */
function normalizeInput(value: number | bigint): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value !== 'number') {
    throw new TypeError(`encodeBase62: value must be a number or bigint, received ${typeof value}`);
  }
  if (!Number.isFinite(value)) {
    throw new TypeError(`encodeBase62: value must be a finite number, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `encodeBase62: value must be a safe integer (pass a bigint for larger values), received ${value}`,
    );
  }
  return BigInt(value);
}
