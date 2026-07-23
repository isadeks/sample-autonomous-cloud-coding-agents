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

import {
  BASE62_ALPHABET,
  decodeBase62,
  encodeBase62,
} from '../../../src/handlers/shared/short-code';

describe('encodeBase62', () => {
  test('encodes zero to the first alphabet character (not empty)', () => {
    expect(encodeBase62(0)).toBe('0');
    expect(encodeBase62(0n)).toBe('0');
  });

  test('encodes single-digit values to their alphabet character', () => {
    expect(encodeBase62(1)).toBe('1');
    expect(encodeBase62(9)).toBe('9');
    expect(encodeBase62(10)).toBe('A');
    expect(encodeBase62(35)).toBe('Z');
    expect(encodeBase62(36)).toBe('a');
    expect(encodeBase62(61)).toBe('z');
  });

  test('rolls over to two digits at base boundary', () => {
    // 62 -> "10", 62*62 = 3844 -> "100"
    expect(encodeBase62(62)).toBe('10');
    expect(encodeBase62(63)).toBe('11');
    expect(encodeBase62(3844)).toBe('100');
  });

  test('produces short, URL-friendly codes for large numbers', () => {
    const code = encodeBase62(1_000_000);
    expect(code).toBe('4C92');
    // A URL-friendly code is only [0-9A-Za-z].
    expect(code).toMatch(/^[0-9A-Za-z]+$/);
  });

  test('accepts bigint for values beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    const code = encodeBase62(big);
    expect(code).toMatch(/^[0-9A-Za-z]+$/);
    expect(decodeBase62(code)).toBe(big);
  });

  test('rejects negative values', () => {
    expect(() => encodeBase62(-1)).toThrow(RangeError);
    expect(() => encodeBase62(-1n)).toThrow(RangeError);
  });

  test('rejects non-integer / non-finite numbers', () => {
    expect(() => encodeBase62(1.5)).toThrow(TypeError);
    expect(() => encodeBase62(NaN)).toThrow(TypeError);
    expect(() => encodeBase62(Infinity)).toThrow(TypeError);
    expect(() => encodeBase62(-Infinity)).toThrow(TypeError);
  });

  test('rejects numbers above the safe-integer range (use bigint instead)', () => {
    expect(() => encodeBase62(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  test('rejects non-number, non-bigint input', () => {
    // @ts-expect-error — exercising runtime guard with a wrong type.
    expect(() => encodeBase62('123')).toThrow(TypeError);
    // @ts-expect-error — exercising runtime guard with a wrong type.
    expect(() => encodeBase62(null)).toThrow(TypeError);
  });
});

describe('decodeBase62', () => {
  test('decodes zero', () => {
    expect(decodeBase62('0')).toBe(0n);
  });

  test('decodes known values back to their integer', () => {
    expect(decodeBase62('A')).toBe(10n);
    expect(decodeBase62('z')).toBe(61n);
    expect(decodeBase62('10')).toBe(62n);
    expect(decodeBase62('100')).toBe(3844n);
    expect(decodeBase62('4C92')).toBe(1_000_000n);
  });

  test('ignores no characters — leading-zero codes still decode', () => {
    // "00" is 0, "01" is 1: decoding is positional and lossless.
    expect(decodeBase62('00')).toBe(0n);
    expect(decodeBase62('01')).toBe(1n);
  });

  test('rejects the empty string', () => {
    expect(() => decodeBase62('')).toThrow(RangeError);
  });

  test('rejects characters outside the base62 alphabet', () => {
    expect(() => decodeBase62('!')).toThrow(RangeError);
    expect(() => decodeBase62('ab-cd')).toThrow(RangeError);
    expect(() => decodeBase62('hello world')).toThrow(RangeError);
    expect(() => decodeBase62('+/')).toThrow(RangeError);
  });

  test('rejects non-string input', () => {
    // @ts-expect-error — exercising runtime guard with a wrong type.
    expect(() => decodeBase62(123)).toThrow(TypeError);
    // @ts-expect-error — exercising runtime guard with a wrong type.
    expect(() => decodeBase62(null)).toThrow(TypeError);
    // @ts-expect-error — exercising runtime guard with a wrong type.
    expect(() => decodeBase62(undefined)).toThrow(TypeError);
  });
});

describe('round-trips', () => {
  test('encode → decode is identity for a spread of values', () => {
    const samples = [
      0, 1, 9, 10, 35, 36, 61, 62, 63, 100, 3843, 3844,
      12_345, 1_000_000, 999_999_999, Number.MAX_SAFE_INTEGER,
    ];
    for (const value of samples) {
      const code = encodeBase62(value);
      expect(decodeBase62(code)).toBe(BigInt(value));
    }
  });

  test('decode → encode is identity for a spread of codes', () => {
    const codes = ['0', '1', 'z', '10', 'zz', 'ABCxyz', '4C92', '100'];
    for (const code of codes) {
      expect(encodeBase62(decodeBase62(code))).toBe(code);
    }
  });

  test('every alphabet character round-trips at its expected index', () => {
    for (let i = 0; i < BASE62_ALPHABET.length; i++) {
      const char = BASE62_ALPHABET[i];
      expect(encodeBase62(i)).toBe(char);
      expect(decodeBase62(char)).toBe(BigInt(i));
    }
  });

  test('large bigint values round-trip losslessly', () => {
    const bigSamples = [
      2n ** 53n,
      2n ** 64n,
      123456789012345678901234567890n,
    ];
    for (const value of bigSamples) {
      expect(decodeBase62(encodeBase62(value))).toBe(value);
    }
  });
});
