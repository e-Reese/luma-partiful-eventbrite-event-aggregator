import { describe, it, expect } from 'vitest';
import { SOURCE_NAMES, isSourceName } from '../src/types.js';

describe('source names', () => {
  it('lists exactly the three supported sources', () => {
    expect(SOURCE_NAMES).toEqual(['luma', 'partiful', 'eventbrite']);
  });

  it('narrows unknown strings', () => {
    expect(isSourceName('luma')).toBe(true);
    expect(isSourceName('meetup')).toBe(false);
  });
});
