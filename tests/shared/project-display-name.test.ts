// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  normalizeProjectDisplayName,
  normalizeProjectMetadata,
  normalizeProjectReferencesInText,
  normalizeProjectReferencesInValue,
} from '../../src/shared/project-display-name.js';

describe('project display name normalization', () => {
  it('maps the old SEOUP label to HPShuttle', () => {
    expect(normalizeProjectDisplayName('SEOUP')).toBe('HPShuttle');
  });

  it('collapses old SEOUP worktree-style display labels to HPShuttle', () => {
    expect(normalizeProjectDisplayName('SEOUP/fix-content-json-25mib-split')).toBe('HPShuttle');
  });

  it('maps the Japanese product name to HPShuttle', () => {
    expect(normalizeProjectDisplayName('ホームページシャトル')).toBe('HPShuttle');
  });

  it('keeps unrelated project names unchanged', () => {
    expect(normalizeProjectDisplayName('claude-mem-upstream')).toBe('claude-mem-upstream');
  });

  it('normalizes metadata.project without dropping other metadata', () => {
    expect(normalizeProjectMetadata({ project: 'SEOUP', platform: 'codex' })).toEqual({
      project: 'HPShuttle',
      platform: 'codex',
    });
  });

  it('normalizes old user-facing names in generated natural language', () => {
    expect(normalizeProjectReferencesInText('SEOUP / HPShuttle の作業')).toBe('HPShuttle の作業');
    expect(normalizeProjectReferencesInText('ホームページシャトル の要約')).toBe('HPShuttle の要約');
    expect(normalizeProjectReferencesInText('SEOUP（旧称 SEOUP）リポジトリ')).toBe('HPShuttleリポジトリ');
  });

  it('does not rewrite literal paths that contain the old name', () => {
    expect(normalizeProjectReferencesInText('SEOUP/experiments/cloudflare-conversion-worker')).toBe(
      'SEOUP/experiments/cloudflare-conversion-worker',
    );
  });

  it('normalizes nested parsed XML values', () => {
    expect(normalizeProjectReferencesInValue({
      title: 'SEOUP の調査',
      facts: ['ホームページシャトル の公開確認'],
    })).toEqual({
      title: 'HPShuttle の調査',
      facts: ['HPShuttle の公開確認'],
    });
  });
});
