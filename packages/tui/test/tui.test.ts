import { describe, expect, it } from 'vitest';
import { TUI_VERSION } from '../src/version.js';

describe('tui package', () => {
  it('exports a version string', () => {
    expect(typeof TUI_VERSION).toBe('string');
    expect(TUI_VERSION.length).toBeGreaterThan(0);
  });
});
