// SPDX-License-Identifier: Apache-2.0

const PROJECT_DISPLAY_NAME_ALIASES: Readonly<Record<string, string>> = {
  SEOUP: 'HPShuttle',
  'ホームページシャトル': 'HPShuttle',
};

export const HP_SHUTTLE_PROJECT_NAME_RULE = [
  'When referring to the user-facing project name, call it "HPShuttle".',
  'Treat "SEOUP" and "ホームページシャトル" as previous names for HPShuttle.',
  'Preserve literal file paths, repository URLs, command names, IDs, and XML tag names unchanged.',
].join(' ');

export function normalizeProjectDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'SEOUP' || trimmed.startsWith('SEOUP/')) return 'HPShuttle';
  if (trimmed === 'ホームページシャトル' || trimmed.startsWith('ホームページシャトル/')) return 'HPShuttle';
  return PROJECT_DISPLAY_NAME_ALIASES[trimmed] ?? trimmed;
}

export function normalizeProjectMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const normalizedProject = normalizeProjectDisplayName(metadata.project);
  if (!normalizedProject) return { ...metadata };
  return {
    ...metadata,
    project: normalizedProject,
  };
}

export function normalizeProjectReferencesInText(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9_/-])SEOUP(?![A-Za-z0-9_/-])/g, 'HPShuttle')
    .replace(/ホームページシャトル/g, 'HPShuttle')
    .replace(/\bHPShuttle\s*\/\s*HPShuttle\b/g, 'HPShuttle')
    .replace(/HPShuttle[（(]\s*旧(?:称|名)\s*HPShuttle\s*[）)]/g, 'HPShuttle');
}

export function normalizeProjectReferencesInValue<T>(value: T): T {
  if (typeof value === 'string') {
    return normalizeProjectReferencesInText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeProjectReferencesInValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeProjectReferencesInValue(item);
    }
    return normalized as T;
  }
  return value;
}
