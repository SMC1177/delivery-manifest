import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('SMS drain schedule seam', () => {
  it('uses */5 8-18 * * * (operator 7pm cutoff; seat corrected 8-18 not 8-17)', () => {
    expect(source).toMatch(/['"]\*\/5 8-18 \* \* \*['"]/);
  });
});
