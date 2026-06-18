// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  getJapanesePromptDisplayText,
  summarizeLongPromptInJapanese,
} from '../../src/shared/prompt-display-summary.js';

describe('prompt display summaries', () => {
  it('prefers stored Japanese summaries', () => {
    const text = getJapanesePromptDisplayText({
      promptText: 'A'.repeat(5000),
      storedSummaryJa: '保存済みの日本語要約です。',
    });

    expect(text).toBe('保存済みの日本語要約です。');
  });

  it('keeps short prompts unchanged', () => {
    const text = getJapanesePromptDisplayText({
      promptText: '本番デプロイして',
    });

    expect(text).toBe('本番デプロイして');
  });

  it('summarizes memory-writing internal prompts in Japanese', () => {
    const text = summarizeLongPromptInJapanese(
      [
        '## Memory Writing Agent: Phase 2 (Consolidation)',
        'Your job: consolidate raw memories and rollout summaries into a local memory folder.',
        'A'.repeat(5000),
      ].join('\n'),
    );

    expect(text).toContain('メモリー書き込みエージェント');
    expect(text).toContain('日本語要約');
    expect(text).not.toContain('Memory Writing Agent');
    expect(text).not.toContain('consolidate raw memories');
  });

  it('summarizes Codex suggestion prompts in Japanese', () => {
    const text = summarizeLongPromptInJapanese(
      [
        '# Overview',
        'Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex.',
        'A'.repeat(5000),
      ].join('\n'),
    );

    expect(text).toContain('自動提案生成');
    expect(text).toContain('日本語要約');
    expect(text).not.toContain('hyperpersonalized suggestions');
  });
});
