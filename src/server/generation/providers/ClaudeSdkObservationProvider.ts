// SPDX-License-Identifier: Apache-2.0

import { query as defaultQuery } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../../sdk/hardened-options.js';
import { buildIsolatedEnvWithFreshOAuth, getAuthMethodDescription } from '../../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../../shared/find-claude-executable.js';
import { OBSERVER_SESSIONS_DIR, ensureDir } from '../../../shared/paths.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { logger } from '../../../utils/logger.js';
import { ABSOLUTE_JAPANESE_NATURAL_LANGUAGE_RULE } from '../../../shared/japanese-output.js';
import { HP_SHUTTLE_PROJECT_NAME_RULE } from '../../../shared/project-display-name.js';
import {
  ServerClassifiedProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';
import { DEFAULT_SERVER_CLAUDE_MODEL } from './ClaudeObservationProvider.js';

type AgentSdkQuery = typeof defaultQuery;

const SERVER_BETA_OBSERVER_SYSTEM_PROMPT = [
  'You are the claude-mem server-beta Observer.',
  'Your only job is to convert the provided agent events into durable memory XML.',
  'Return only XML. Do not include Markdown fences, greetings, explanations, or prose outside XML.',
  'Valid outputs are one or more <observation>...</observation> blocks, exactly one <summary>...</summary> block, or one self-closing <skip_summary /> tag.',
  ABSOLUTE_JAPANESE_NATURAL_LANGUAGE_RULE,
  HP_SHUTTLE_PROJECT_NAME_RULE,
  'Keep XML tag names, observation type identifiers, command names, file paths, IDs, and provider/job identifiers unchanged.',
].join('\n');

export interface ClaudeSdkObservationProviderOptions {
  model?: string;
  queryImpl?: AgentSdkQuery;
  findClaudeExecutableImpl?: typeof findClaudeExecutable;
  buildEnvWithFreshOAuth?: typeof buildIsolatedEnvWithFreshOAuth;
}

/**
 * Server-beta Claude provider for subscription / Claude Code OAuth auth.
 *
 * The existing ClaudeObservationProvider intentionally uses the Anthropic
 * Messages REST API and an explicit API key. This adapter uses the same
 * hardened Claude Agent SDK path as the local worker, so operators can mount
 * Claude Code OAuth credentials into the server-beta worker and avoid direct
 * per-token Anthropic API-key billing.
 */
export class ClaudeSdkObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  private readonly model: string;
  private readonly queryImpl: AgentSdkQuery;
  private readonly findClaudeExecutableImpl: typeof findClaudeExecutable;
  private readonly buildEnvWithFreshOAuth: typeof buildIsolatedEnvWithFreshOAuth;

  constructor(options: ClaudeSdkObservationProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_SERVER_CLAUDE_MODEL;
    this.queryImpl = options.queryImpl ?? defaultQuery;
    this.findClaudeExecutableImpl = options.findClaudeExecutableImpl ?? findClaudeExecutable;
    this.buildEnvWithFreshOAuth = options.buildEnvWithFreshOAuth ?? buildIsolatedEnvWithFreshOAuth;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = this.findClaudeExecutableImpl('SDK');
    const isolatedEnv = sanitizeEnv(await this.buildEnvWithFreshOAuth());
    const abortController = bridgeAbortSignal(signal);
    const options = buildHardenedSdkOptions({
      source: 'Observer',
      contentSessionId: context.project.serverSessionId ?? undefined,
      project: context.project.projectName ?? context.project.projectId,
      model: this.model,
      env: isolatedEnv,
      pathToClaudeCodeExecutable: claudePath,
      ...(abortController ? { abortController } : {}),
    });
    const queryResult = this.queryImpl({
      prompt,
      options: {
        ...options,
        systemPrompt: SERVER_BETA_OBSERVER_SYSTEM_PROMPT,
        maxTurns: 1,
        promptSuggestions: false,
      },
    });

    let rawText = '';
    let tokensUsed: number | undefined;
    let resultError: string | undefined;

    try {
      for await (const message of queryResult) {
        const maybeSessionId = (message as { session_id?: unknown }).session_id;
        if (typeof maybeSessionId === 'string') {
          logger.debug('SDK', 'server-beta SDK observation query session observed', {
            serverSessionId: context.project.serverSessionId ?? undefined,
            memorySessionId: maybeSessionId,
          });
        }

        if ((message as { type?: string }).type === 'assistant') {
          const textContent = extractAssistantText(message);
          if (textContent) {
            rawText = rawText ? `${rawText}\n${textContent}` : textContent;
          }
        }

        if ((message as { type?: string }).type === 'result') {
          tokensUsed = extractResultTokens(message) ?? tokensUsed;
          const result = message as { is_error?: boolean; errors?: unknown; subtype?: string };
          if (result.is_error) {
            resultError = formatSdkResultError(result);
          }
        }
      }
    } catch (error) {
      if (rawText.trim().length > 0) {
        logger.debug('SDK', 'server-beta SDK query threw after assistant text was captured; using captured text', {
          provider: this.providerLabel,
          model: this.model,
        }, error instanceof Error ? error : new Error(String(error)));
      } else {
        throw classifyClaudeSdkServerError(error);
      }
    }

    if (rawText.trim().length === 0 && resultError) {
      throw classifyClaudeSdkServerError(new Error(resultError));
    }

    logger.info('SDK', 'server-beta SDK observation generation completed', {
      provider: this.providerLabel,
      model: this.model,
      authMethod: getAuthMethodDescription(),
      tokensUsed,
    });

    return {
      rawText: rawText.trim(),
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

function bridgeAbortSignal(signal: AbortSignal | undefined): AbortController | undefined {
  if (!signal) return undefined;
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

function extractAssistantText(message: unknown): string {
  const assistant = message as {
    message?: {
      content?: unknown;
    };
  };
  const content = assistant.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: unknown): block is { type?: string; text?: string } =>
      !!block && typeof block === 'object' && (block as { type?: string }).type === 'text',
    )
    .map(block => block.text ?? '')
    .filter(text => text.length > 0)
    .join('\n');
}

function extractResultTokens(message: unknown): number | undefined {
  const usage = (message as {
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  }).usage;
  if (!usage) return undefined;
  const values = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ].filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

function formatSdkResultError(result: { errors?: unknown; subtype?: string }): string {
  const errors = Array.isArray(result.errors)
    ? result.errors.map(error => String(error)).filter(Boolean).join('; ')
    : typeof result.errors === 'string'
      ? result.errors
      : '';
  return errors || `Claude Agent SDK result error${result.subtype ? `: ${result.subtype}` : ''}`;
}

export function classifyClaudeSdkServerError(err: unknown): ServerClassifiedProviderError {
  const message = err instanceof Error ? err.message : String(err);
  const errAny = err as { name?: string; status?: number; error?: { type?: string }; body?: unknown };
  const lower = message.toLowerCase();

  if (
    message.includes('Claude executable not found') ||
    message.includes('CLAUDE_CODE_PATH') ||
    message.includes('ENOENT') ||
    message.startsWith('spawn ')
  ) {
    return new ServerClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  if (
    errAny.status === 401 ||
    errAny.status === 403 ||
    lower.includes('invalid api key') ||
    lower.includes('api_key_invalid') ||
    (lower.includes('oauth') && lower.includes('expired')) ||
    lower.includes('not logged in') ||
    lower.includes('login required') ||
    lower.includes('authentication')
  ) {
    return new ServerClassifiedProviderError(message, { kind: 'auth_invalid', cause: err });
  }

  if (
    errAny.name === 'OverloadedError' ||
    errAny.status === 529 ||
    errAny.error?.type === 'overloaded_error' ||
    lower.includes('overloaded')
  ) {
    return new ServerClassifiedProviderError(message || 'Anthropic overloaded', {
      kind: 'transient',
      cause: err,
    });
  }

  if (errAny.status === 429 || lower.includes('rate limit')) {
    return new ServerClassifiedProviderError(message, { kind: 'rate_limit', cause: err });
  }

  if (lower.includes('quota exceeded') || lower.includes('quota')) {
    return new ServerClassifiedProviderError(message, { kind: 'quota_exhausted', cause: err });
  }

  if (
    errAny.status === 400 ||
    lower.includes('prompt is too long') ||
    lower.includes('context window') ||
    lower.includes('invalid_request_error')
  ) {
    return new ServerClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  if (typeof errAny.status === 'number' && errAny.status >= 500 && errAny.status < 600) {
    return new ServerClassifiedProviderError(message, { kind: 'transient', cause: err });
  }

  return new ServerClassifiedProviderError(message, { kind: 'transient', cause: err });
}
