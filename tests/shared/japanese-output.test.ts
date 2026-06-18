import { describe, expect, it } from 'bun:test';

import {
  JAPANESE_LANGUAGE_REQUIREMENT_VIOLATION,
  validateJapaneseNaturalLanguageFields,
} from '../../src/shared/japanese-output.js';

describe('validateJapaneseNaturalLanguageFields', () => {
  it('rejects English-only natural-language output', () => {
    const result = validateJapaneseNaturalLanguageFields('summary', [
      'Investigated the Docker worker queue and fixed stale BullMQ jobs.',
    ]);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain(JAPANESE_LANGUAGE_REQUIREMENT_VIOLATION);
  });

  it('accepts Japanese output with technical terms and identifiers', () => {
    const result = validateJapaneseNaturalLanguageFields('summary', [
      'Docker worker の BullMQ キューを確認し、stale job の再投入処理を修正した。',
      'CLAUDE_MEM_GENERATION_EVENT_CONCURRENCY は 4 のまま維持した。',
    ]);

    expect(result.valid).toBe(true);
  });
});
