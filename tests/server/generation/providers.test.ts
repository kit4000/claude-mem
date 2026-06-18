// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
  parseRetryAfterMs,
} from '../../../src/server/generation/providers/shared/error-classification.js';
import { classifyClaudeServerError } from '../../../src/server/generation/providers/ClaudeObservationProvider.js';
import {
  ClaudeObservationProvider,
} from '../../../src/server/generation/providers/ClaudeObservationProvider.js';
import {
  ClaudeSdkObservationProvider,
  classifyClaudeSdkServerError,
} from '../../../src/server/generation/providers/ClaudeSdkObservationProvider.js';
import { GeminiObservationProvider } from '../../../src/server/generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';
import { buildServerGenerationPrompt } from '../../../src/server/generation/providers/shared/prompt-builder.js';
import { classifyProviderRawTextFailure } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

function makeContext(overrides: Partial<{
  payload: unknown;
  serverSessionId: string | null;
  sourceType: 'agent_event' | 'session_summary';
}> = {}): ServerGenerationContext {
  const sourceType = overrides.sourceType ?? 'agent_event';
  const serverSessionId = overrides.serverSessionId ?? (sourceType === 'session_summary' ? 'session-1' : null);
  return {
    job: {
      id: 'job-1',
      projectId: 'proj-1',
      teamId: 'team-1',
      agentEventId: sourceType === 'agent_event' ? 'evt-1' : null,
      sourceType,
      sourceId: sourceType === 'agent_event' ? 'evt-1' : serverSessionId!,
      serverSessionId,
      jobType: sourceType === 'agent_event' ? 'observation_generate_for_event' : 'session_summary_generate',
      status: 'processing',
      idempotencyKey: 'k',
      bullmqJobId: null,
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAtEpoch: null,
      lockedAtEpoch: null,
      lockedBy: null,
      completedAtEpoch: null,
      failedAtEpoch: null,
      cancelledAtEpoch: null,
      lastError: null,
      payload: {},
      createdAtEpoch: 0,
      updatedAtEpoch: 0,
    },
    events: [
      {
        id: 'evt-1',
        projectId: 'proj-1',
        teamId: 'team-1',
        serverSessionId,
        sourceAdapter: 'api',
        sourceEventId: null,
        idempotencyKey: 'k',
        eventType: 'tool_use',
        payload: overrides.payload ?? { tool: 'bash', input: 'ls' },
        metadata: {},
        occurredAtEpoch: 0,
        receivedAtEpoch: 0,
        createdAtEpoch: 0,
      },
    ],
    project: {
      projectId: 'proj-1',
      teamId: 'team-1',
      serverSessionId,
      projectName: 'demo',
    },
  };
}

describe('shared error classification', () => {
  it('parseRetryAfterMs returns ms for numeric values', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('classifyHttpProviderError returns rate_limit on 429', () => {
    const err = classifyHttpProviderError({ status: 429, cause: new Error('rl'), providerLabel: 'X' });
    expect(err.kind).toBe('rate_limit');
  });

  it('classifyHttpProviderError returns auth_invalid on 401/403', () => {
    expect(classifyHttpProviderError({ status: 401, cause: 'x', providerLabel: 'X' }).kind).toBe('auth_invalid');
    expect(classifyHttpProviderError({ status: 403, cause: 'x', providerLabel: 'X' }).kind).toBe('auth_invalid');
  });

  it('classifyHttpProviderError detects quota body markers regardless of status', () => {
    const err = classifyHttpProviderError({
      status: 500,
      bodyText: 'RESOURCE_EXHAUSTED',
      cause: new Error(''),
      providerLabel: 'Gemini',
    });
    expect(err.kind).toBe('quota_exhausted');
  });

  it('classifyClaudeServerError treats 529 as transient', () => {
    expect(classifyClaudeServerError({ status: 529, cause: 'x' }).kind).toBe('transient');
  });

  it('classifyClaudeServerError treats prompt-too-long as unrecoverable', () => {
    expect(
      classifyClaudeServerError({ status: 400, bodyText: 'prompt is too long', cause: 'x' }).kind,
    ).toBe('unrecoverable');
  });

  it('classifies raw Claude Code non-XML failures before treating them as parser errors', () => {
    expect(classifyProviderRawTextFailure('API Error: Connection closed while thinking, before producing a response. Try again.')).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyProviderRawTextFailure('Failed to authenticate. API Error: 401 Invalid authentication credentials')).toEqual({
      classification: 'auth_invalid',
      retryable: false,
    });
  });
});

describe('buildServerGenerationPrompt', () => {
  it('strips <private> tags from event payload before sending', () => {
    const context = makeContext({
      payload: '<private>secret</private>visible',
    });
    const result = buildServerGenerationPrompt(context);
    expect(result.prompt).not.toContain('secret');
    expect(result.prompt).toContain('visible');
    expect(result.hadPrivateContent).toBe(true);
    expect(result.skippedAll).toBe(false);
  });

  it('marks skippedAll when every event is fully private', () => {
    const context = makeContext({ payload: '<private>secret</private>' });
    const result = buildServerGenerationPrompt(context);
    expect(result.skippedAll).toBe(true);
    expect(result.hadPrivateContent).toBe(true);
  });

  it('includes generation_job_id and project metadata in the prompt', () => {
    const result = buildServerGenerationPrompt(makeContext({ serverSessionId: 'session-x' }));
    expect(result.prompt).toContain('<generation_job_id>job-1</generation_job_id>');
    expect(result.prompt).toContain('<server_session_id>session-x</server_session_id>');
    expect(result.prompt).toContain('<project_name>demo</project_name>');
  });

  it('requires Japanese natural-language output for observations', () => {
    const result = buildServerGenerationPrompt(makeContext());
    expect(result.prompt).toContain('ABSOLUTE LANGUAGE RULE - JAPANESE ONLY');
    expect(result.prompt).toContain('絶対ルール: 自然文フィールドは必ず日本語で書くこと');
    expect(result.prompt).toContain('Schema for each <observation> block:');
  });

  it('uses summary XML and Japanese output instructions for session summary jobs', () => {
    const result = buildServerGenerationPrompt(makeContext({ sourceType: 'session_summary' }));
    expect(result.prompt).toContain('<server_beta_summary_request>');
    expect(result.prompt).toContain('one <summary>...</summary> XML block');
    expect(result.prompt).toContain('ABSOLUTE LANGUAGE RULE - JAPANESE ONLY');
    expect(result.prompt).toContain('English natural-language sentences in <title>');
    expect(result.prompt).toContain('Schema for the <summary> block:');
    expect(result.prompt).not.toContain('Schema for each <observation> block:');
  });

  it('keeps session summary prompts bounded for long sessions', () => {
    const context = makeContext({ sourceType: 'session_summary' });
    const largePayload = 'x'.repeat(10_000);
    const manyEvents = Array.from({ length: 40 }, (_, index) => ({
      ...context.events[0]!,
      id: `evt-${index}`,
      payload: { index, largePayload },
      occurredAtEpoch: index,
    }));
    const result = buildServerGenerationPrompt({ ...context, events: manyEvents });
    expect(result.prompt).toContain('older events omitted');
    expect(result.prompt).not.toContain('<id>evt-0</id>');
    expect(result.prompt).toContain('<id>evt-39</id>');
    expect(result.prompt.length).toBeLessThan(90_000);
  });
});

class FakeFetch {
  constructor(private readonly response: Response | (() => Response)) {}
  fetch: typeof fetch = async () => {
    return typeof this.response === 'function' ? this.response() : this.response;
  };
}

class CapturingFetch {
  lastUrl: string | undefined;
  lastInit: RequestInit | undefined;
  constructor(private readonly response: Response) {}
  fetch: typeof fetch = async (input, init) => {
    this.lastUrl = typeof input === 'string' ? input : input.toString();
    this.lastInit = init;
    return this.response;
  };
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

describe('ClaudeObservationProvider', () => {
  it('returns synthetic skip when prompt builder reports skippedAll', async () => {
    const provider = new ClaudeObservationProvider({ apiKey: 'fake', fetchImpl: async () => {
      throw new Error('should not be called');
    } });
    const context = makeContext({ payload: '<private>secret</private>' });
    const result = await provider.generate(context);
    expect(result.rawText).toContain('<skip_summary');
  });

  it('parses Anthropic Messages text content into rawText', async () => {
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        content: [
          { type: 'text', text: '<observation><type>x</type><title>t</title></observation>' },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );
    const provider = new ClaudeObservationProvider({
      apiKey: 'sk-fake',
      fetchImpl: fakeFetch.fetch,
    });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(30);
    expect(result.providerLabel).toBe('claude');
  });

  it('classifies non-OK responses through classifyClaudeServerError', async () => {
    const fakeFetch = new FakeFetch(jsonResponse(401, { error: { message: 'Invalid API key' } }));
    const provider = new ClaudeObservationProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch.fetch });
    await expect(provider.generate(makeContext())).rejects.toBeInstanceOf(ServerClassifiedProviderError);
  });
});

describe('ClaudeSdkObservationProvider', () => {
  it('returns synthetic skip without starting the SDK when prompt builder reports skippedAll', async () => {
    let sdkCalled = false;
    const provider = new ClaudeSdkObservationProvider({
      queryImpl: (() => {
        sdkCalled = true;
        throw new Error('should not be called');
      }) as any,
      findClaudeExecutableImpl: (() => {
        throw new Error('should not resolve claude');
      }) as any,
      buildEnvWithFreshOAuth: (async () => ({})) as any,
    });
    const result = await provider.generate(makeContext({ payload: '<private>secret</private>' }));
    expect(result.rawText).toContain('<skip_summary');
    expect(sdkCalled).toBe(false);
  });

  it('uses the Agent SDK stream and returns assistant text with result token usage', async () => {
    let capturedInput: { prompt?: string; options?: { systemPrompt?: unknown; maxTurns?: unknown; promptSuggestions?: unknown } } | null = null;
    async function* fakeQuery() {
      yield {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          content: [
            { type: 'text', text: '<observation><type>x</type><title>sdk</title></observation>' },
          ],
        },
      };
      yield {
        type: 'result',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 4,
        },
      };
    }

    const provider = new ClaudeSdkObservationProvider({
      queryImpl: ((input: typeof capturedInput) => {
        capturedInput = input;
        return fakeQuery();
      }) as any,
      findClaudeExecutableImpl: (() => '/usr/local/bin/claude') as any,
      buildEnvWithFreshOAuth: (async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fresh' })) as any,
    });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(19);
    expect(result.providerLabel).toBe('claude');
    expect(capturedInput?.options?.systemPrompt).toContain('Return only XML');
    expect(capturedInput?.options?.systemPrompt).toContain('Japanese');
    expect(capturedInput?.options?.maxTurns).toBe(1);
    expect(capturedInput?.options?.promptSuggestions).toBe(false);
  });

  it('classifies Claude executable failures as unrecoverable', () => {
    const err = classifyClaudeSdkServerError(new Error('Claude executable not found'));
    expect(err).toBeInstanceOf(ServerClassifiedProviderError);
    expect(err.kind).toBe('unrecoverable');
  });
});

describe('GeminiObservationProvider', () => {
  it('parses generateContent response into rawText', async () => {
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '<observation><type>x</type><title>g</title></observation>' }] } }],
        usageMetadata: { totalTokenCount: 42 },
      }),
    );
    const provider = new GeminiObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(42);
    expect(result.providerLabel).toBe('gemini');
  });
});

describe('OpenRouterObservationProvider', () => {
  it('parses OpenAI-style response and reports tokensUsed', async () => {
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        choices: [{ message: { content: '<observation><type>x</type><title>o</title></observation>' } }],
        usage: { total_tokens: 100 },
      }),
    );
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(100);
    expect(result.providerLabel).toBe('openrouter');
  });

  it('classifies a 429 response as rate_limit', async () => {
    const fakeFetch = new FakeFetch(jsonResponse(429, { error: { message: 'rl' } }));
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });
    try {
      await provider.generate(makeContext());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerClassifiedProviderError);
      expect((error as ServerClassifiedProviderError).kind).toBe('rate_limit');
    }
  });

  // #2382/#2590/#2622/#2393 — configurable OpenAI-compatible base URL.
  it('POSTs to the default OpenRouter URL when baseUrl is unset', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: capturing.fetch });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('appends /chat/completions to a DeepSeek-style base URL', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('https://api.deepseek.com/chat/completions');
  });

  it('uses a full chat/completions base URL verbatim and normalizes trailing slash', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      baseUrl: 'http://localhost:1234/v1/chat/completions/',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('sends the configured model verbatim in the request body (#2393)', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    const body = JSON.parse(String(capturing.lastInit?.body)) as { model?: string };
    expect(body.model).toBe('deepseek-chat');
  });
});
