// SPDX-License-Identifier: Apache-2.0

export const JAPANESE_LANGUAGE_REQUIREMENT_VIOLATION = 'Japanese language requirement violation';

export const ABSOLUTE_JAPANESE_NATURAL_LANGUAGE_RULE = [
  'ABSOLUTE LANGUAGE RULE - JAPANESE ONLY:',
  '- This is a hard protocol rule, not a style preference.',
  '- Every human-readable natural-language field MUST be written in Japanese.',
  '- English natural-language sentences in <title>, <subtitle>, <fact>, <narrative>, <request>, <investigated>, <learned>, <completed>, <next_steps>, or <notes> are invalid and will be rejected.',
  '- Translate or summarize source text into Japanese. Do not copy English prose except exact commands, file paths, identifiers, XML tags, product/API names, or short quoted literals that must remain unchanged.',
  '- If a technical English term is necessary, embed it inside a Japanese sentence.',
  '- 絶対ルール: 自然文フィールドは必ず日本語で書くこと。英語の自然文をそのまま出力してはいけない。',
].join('\n');

export type JapaneseNaturalLanguageField =
  | string
  | null
  | undefined
  | readonly string[];

export interface JapaneseNaturalLanguageValidationResult {
  valid: boolean;
  reason?: string;
  japaneseChars: number;
  latinLetters: number;
}

const JAPANESE_SCRIPT_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN_WORD_RE = /\b[A-Za-z]{3,}\b/g;

export function validateJapaneseNaturalLanguageFields(
  label: string,
  fields: readonly JapaneseNaturalLanguageField[],
): JapaneseNaturalLanguageValidationResult {
  const text = fields.flatMap(field => {
    if (Array.isArray(field)) return field;
    return field ? [field] : [];
  }).join('\n');

  if (text.trim().length === 0) {
    return { valid: true, japaneseChars: 0, latinLetters: 0 };
  }

  const normalized = stripAllowedLiterals(text);
  const japaneseChars = countMatches(normalized, JAPANESE_SCRIPT_RE);
  const latinWords = normalized.match(LATIN_WORD_RE) ?? [];
  const latinLetters = latinWords.reduce((sum, word) => sum + word.length, 0);

  if (latinLetters === 0) {
    return { valid: true, japaneseChars, latinLetters };
  }

  if (japaneseChars === 0) {
    return {
      valid: false,
      reason: `${JAPANESE_LANGUAGE_REQUIREMENT_VIOLATION}: ${label} has English natural-language text but no Japanese script`,
      japaneseChars,
      latinLetters,
    };
  }

  if (latinWords.length >= 12 && latinLetters > Math.max(120, japaneseChars * 8)) {
    return {
      valid: false,
      reason: `${JAPANESE_LANGUAGE_REQUIREMENT_VIOLATION}: ${label} is English-dominant`,
      japaneseChars,
      latinLetters,
    };
  }

  return { valid: true, japaneseChars, latinLetters };
}

function stripAllowedLiterals(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b[A-Z0-9_]{3,}\b/g, ' ')
    .replace(/\b[\w.-]+\/[\w./-]+\b/g, ' ')
    .replace(/(?:^|\s)(?:[~./]|[A-Za-z]:[\\/])\S+/g, ' ')
    .replace(/\b\w+[\w.-]*\.(?:ts|tsx|js|jsx|json|md|yml|yaml|sh|py|go|rs|java|kt|swift|css|html)\b/gi, ' ');
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return Array.from(text.matchAll(pattern)).length;
}
