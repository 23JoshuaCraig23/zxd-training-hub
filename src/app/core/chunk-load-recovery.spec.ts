import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './chunk-load-recovery';

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://example.com/chunk-old.js',
    'Importing a module script failed.',
    'Loading chunk dashboard failed',
    'ChunkLoadError: Loading chunk 42 failed',
  ])('recognizes stale deployment errors: %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('does not reload for ordinary network or authentication errors', () => {
    expect(isChunkLoadError(new Error('Firebase: Error (auth/wrong-password).'))).toBe(false);
    expect(isChunkLoadError(new Error('Failed to fetch'))).toBe(false);
  });
});
