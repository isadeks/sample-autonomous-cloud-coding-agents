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

import { idForCode, InMemoryLinkStore } from '../../../src/handlers/shared/link-store';
import { encodeBase62 } from '../../../src/handlers/shared/short-code';

describe('InMemoryLinkStore.save', () => {
  test('returns a URL-friendly short code for a saved URL', () => {
    const store = new InMemoryLinkStore();
    const code = store.save('https://example.com/some/long/path');
    expect(code).toMatch(/^[0-9A-Za-z]+$/);
  });

  test('issues codes from the base62-encoded id space, starting at "0"', () => {
    const store = new InMemoryLinkStore();
    expect(store.save('https://example.com/a')).toBe(encodeBase62(0));
    expect(store.save('https://example.com/b')).toBe(encodeBase62(1));
    expect(store.save('https://example.com/c')).toBe(encodeBase62(2));
  });

  test('assigns distinct codes to distinct URLs', () => {
    const store = new InMemoryLinkStore();
    const first = store.save('https://example.com/one');
    const second = store.save('https://example.com/two');
    expect(first).not.toBe(second);
  });

  test('tracks the number of distinct URLs via size', () => {
    const store = new InMemoryLinkStore();
    expect(store.size).toBe(0);
    store.save('https://example.com/a');
    store.save('https://example.com/b');
    expect(store.size).toBe(2);
  });

  test('rejects a non-string url', () => {
    const store = new InMemoryLinkStore();
    // @ts-expect-error — exercising the runtime guard with a wrong type.
    expect(() => store.save(123)).toThrow(TypeError);
    // @ts-expect-error — exercising the runtime guard with a wrong type.
    expect(() => store.save(null)).toThrow(TypeError);
  });

  test('rejects an empty url', () => {
    const store = new InMemoryLinkStore();
    expect(() => store.save('')).toThrow(RangeError);
  });
});

describe('InMemoryLinkStore.lookup', () => {
  test('retrieves the original URL for a saved code', () => {
    const store = new InMemoryLinkStore();
    const url = 'https://example.com/retrieve/me';
    const code = store.save(url);
    expect(store.lookup(code)).toBe(url);
  });

  test('round-trips multiple URLs to their own originals', () => {
    const store = new InMemoryLinkStore();
    const urls = [
      'https://example.com/a',
      'https://example.com/b?q=1&r=2',
      'https://example.com/c#frag',
    ];
    const codes = urls.map((u) => store.save(u));
    codes.forEach((code, i) => {
      expect(store.lookup(code)).toBe(urls[i]);
    });
  });

  test('returns undefined for an unknown code', () => {
    const store = new InMemoryLinkStore();
    store.save('https://example.com/a');
    expect(store.lookup('zzz')).toBeUndefined();
  });

  test('returns undefined for an unknown code without throwing (malformed input)', () => {
    const store = new InMemoryLinkStore();
    expect(store.lookup('not a real code!')).toBeUndefined();
    expect(store.lookup('')).toBeUndefined();
    // @ts-expect-error — exercising the runtime guard with a wrong type.
    expect(store.lookup(123)).toBeUndefined();
  });

  test('does not resolve a code the store never issued, even if it is valid base62', () => {
    const store = new InMemoryLinkStore();
    store.save('https://example.com/a'); // issues code for id 0
    // "1" is valid base62 (id 1) but no URL has been saved for it yet.
    expect(store.lookup(encodeBase62(1))).toBeUndefined();
  });
});

describe('InMemoryLinkStore stable codes for repeated inputs', () => {
  test('saving the same URL twice returns the same code', () => {
    const store = new InMemoryLinkStore();
    const url = 'https://example.com/stable';
    const first = store.save(url);
    const second = store.save(url);
    expect(second).toBe(first);
  });

  test('a duplicate save does not allocate a new id or grow the store', () => {
    const store = new InMemoryLinkStore();
    store.save('https://example.com/a'); // id 0
    store.save('https://example.com/dup'); // id 1
    expect(store.size).toBe(2);

    const before = store.save('https://example.com/dup');
    expect(store.size).toBe(2); // no growth

    // A brand-new URL still gets the next id (2), proving the duplicate did
    // not consume an id.
    const fresh = store.save('https://example.com/next');
    expect(fresh).toBe(encodeBase62(2));
    expect(before).toBe(encodeBase62(1));
  });

  test('interleaved duplicate saves keep resolving to the original URL', () => {
    const store = new InMemoryLinkStore();
    const codeA = store.save('https://example.com/a');
    store.save('https://example.com/b');
    const codeAgain = store.save('https://example.com/a');
    expect(codeAgain).toBe(codeA);
    expect(store.lookup(codeA)).toBe('https://example.com/a');
  });
});

describe('idForCode', () => {
  test('recovers the numeric id a code was issued from', () => {
    const store = new InMemoryLinkStore();
    const first = store.save('https://example.com/a');
    const second = store.save('https://example.com/b');
    expect(idForCode(first)).toBe(0n);
    expect(idForCode(second)).toBe(1n);
  });
});
