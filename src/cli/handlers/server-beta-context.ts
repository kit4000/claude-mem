// SPDX-License-Identifier: Apache-2.0

import type { HookResult, NormalizedHookInput } from '../types.js';
import type { ProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveRuntimeContext, logServerBetaFallback } from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';

interface ServerBetaContextHookOptions {
  hookEventName: string;
  projectContext: ProjectContext;
  query?: string;
  limit?: number;
}

export interface ServerBetaContextHookResult {
  handled: boolean;
  hookResult?: HookResult;
}

export async function getServerBetaContextForHook(
  input: NormalizedHookInput,
  options: ServerBetaContextHookOptions,
): Promise<ServerBetaContextHookResult> {
  const runtime = resolveRuntimeContext();
  if (runtime.runtime !== 'server-beta') {
    return { handled: false };
  }

  const query = normalizeContextQuery(options.query);
  try {
    const response = await runtime.client.contextObservations({
      projectId: runtime.projectId,
      ...(query ? { query } : {}),
      limit: options.limit ?? 10,
    });
    const additionalContext = typeof response.context === 'string' ? response.context.trim() : '';
    const observationCount = Array.isArray(response.observations) ? response.observations.length : 0;

    await recordContextInjectionEvent(input, {
      projectId: runtime.projectId,
      query,
      observationCount,
      contextLength: additionalContext.length,
      hookEventName: options.hookEventName,
      projectContext: options.projectContext,
    });

    if (!additionalContext) {
      return {
        handled: true,
        hookResult: {
          continue: true,
          suppressOutput: true,
          exitCode: HOOK_EXIT_CODES.SUCCESS,
        },
      };
    }

    return {
      handled: true,
      hookResult: {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: options.hookEventName,
          additionalContext,
        },
        exitCode: HOOK_EXIT_CODES.SUCCESS,
      },
    };
  } catch (error: unknown) {
    if (isServerBetaClientError(error) && error.isFallbackEligible()) {
      logServerBetaFallback(error.kind, {
        status: error.status,
        message: error.message,
        route: '/v1/context',
      });
      return { handled: false };
    }

    logger.error('HOOK', 'Server beta context lookup failed (non-recoverable)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      handled: true,
      hookResult: {
        continue: true,
        suppressOutput: true,
        exitCode: HOOK_EXIT_CODES.SUCCESS,
      },
    };
  }
}

function normalizeContextQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function recordContextInjectionEvent(
  input: NormalizedHookInput,
  details: {
    projectId: string;
    query: string | undefined;
    observationCount: number;
    contextLength: number;
    hookEventName: string;
    projectContext: ProjectContext;
  },
): Promise<void> {
  const runtime = resolveRuntimeContext();
  if (runtime.runtime !== 'server-beta') return;

  try {
    await runtime.client.recordEvent({
      projectId: details.projectId,
      contentSessionId: input.sessionId,
      sourceType: 'hook',
      eventType: 'context_injection',
      occurredAtEpoch: Date.now(),
      generate: false,
      payload: {
        hook_event_name: details.hookEventName,
        query: details.query ?? null,
        result_count: details.observationCount,
        context_length: details.contextLength,
        cwd: input.cwd,
        project: details.projectContext.primary,
        projects: details.projectContext.allProjects,
        platformSource: normalizePlatformSource(input.platform),
      },
    });
  } catch (error: unknown) {
    logger.warn('HOOK', 'Server beta context injection audit event failed; continuing without blocking context', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
