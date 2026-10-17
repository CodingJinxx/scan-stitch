import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';

describe('smoke', () => {
  it('has default stability delay', () => {
    expect(DEFAULT_SETTINGS.stabilityDelayMs).toBe(1000);
  });
});
