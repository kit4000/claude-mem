// SPDX-License-Identifier: Apache-2.0

const LONG_PROMPT_DISPLAY_THRESHOLD = 2000;

interface PromptDisplayTextInput {
  promptText: string;
  storedSummaryJa?: string | null;
}

export function getJapanesePromptDisplayText(input: PromptDisplayTextInput): string {
  const storedSummary = normalizeDisplayText(input.storedSummaryJa);
  if (storedSummary) {
    return storedSummary;
  }

  if (input.promptText.length <= LONG_PROMPT_DISPLAY_THRESHOLD) {
    return input.promptText;
  }

  return summarizeLongPromptInJapanese(input.promptText);
}

export function summarizeLongPromptInJapanese(promptText: string): string {
  const chars = promptText.length.toLocaleString('ja-JP');
  const lower = promptText.toLowerCase();

  if (lower.includes('memory writing agent') || lower.includes('consolidate raw memories')) {
    return [
      'メモリー書き込みエージェント用の長大な内部プロンプトです。',
      '目的: 過去の会話記録やロールアウト要約を整理し、将来のエージェントが段階的に参照できるローカル記憶フォルダへ統合すること。',
      '主な内容: ユーザー理解、作業履歴、重要な判断、再利用しやすい検索語を抽出し、重複を減らして保存すること。',
      `元の本文は約${chars}文字のため、viewer では日本語要約で表示しています。`,
    ].join('\n');
  }

  if (lower.includes('hyperpersonalized suggestions')) {
    return [
      'Codex の自動提案生成用の長大な内部プロンプトです。',
      '目的: 接続アプリや現在のプロジェクト状況を読み取り、ユーザーが次に実行できる具体的な提案を最大3件作ること。',
      '主な内容: ユーザーの意図、最近の作業、ローカルプロジェクトの文脈を踏まえ、すぐ実行可能な作業候補に絞ること。',
      `元の本文は約${chars}文字のため、viewer では日本語要約で表示しています。`,
    ].join('\n');
  }

  if (lower.includes('safety and compliance') || lower.includes('ambient suggestions')) {
    return [
      'Codex の自動提案を安全性と適切性の観点で確認する長大な内部審査プロンプトです。',
      '目的: 表示してはいけない内容、ユーザー文脈がない場合に避ける内容、提案として出してよい条件を判定すること。',
      '主な内容: プライバシー、危険行為、不要な個人情報利用、過度に推測的な提案を除外するための基準を確認すること。',
      `元の本文は約${chars}文字のため、viewer では日本語要約で表示しています。`,
    ].join('\n');
  }

  return [
    '長大な内部プロンプトのため、日本語要約で表示しています。',
    '目的: Codex または連携エージェントに、現在のプロジェクト文脈を読み取り、必要な処理や判断を行うよう指示しています。',
    `元の本文は約${chars}文字のため、viewer では読みやすさを優先して圧縮しています。`,
  ].join('\n');
}

function normalizeDisplayText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
