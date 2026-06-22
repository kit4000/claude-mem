// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realRuntimeSelector from '../../src/services/hooks/runtime-selector.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realLogger from '../../src/utils/logger.js';
import * as realShouldTrackProject from '../../src/shared/should-track-project.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realProjectNameSnapshot = { ...realProjectName };
const realLoggerSnapshot = { ...realLogger };
const realShouldTrackProjectSnapshot = { ...realShouldTrackProject };

type ClientCall = Record<string, unknown>;

let runtimeMode: 'worker' | 'server-beta' = 'server-beta';
let contextResponse = {
  observations: [
    { id: 'obs-1', projectId: 'project-1', content: 'alpha' },
    { id: 'obs-2', projectId: 'project-1', content: 'beta' },
  ],
  context: 'alpha\n\nbeta',
};
const calls: {
  startSession: ClientCall[];
  contextObservations: ClientCall[];
  recordEvent: ClientCall[];
} = {
  startSession: [],
  contextObservations: [],
  recordEvent: [],
};

const mockClient = {
  startSession: mock(async (input: ClientCall) => {
    calls.startSession.push(input);
    return { session: { id: 'server-session-1', projectId: 'project-1' } };
  }),
  contextObservations: mock(async (input: ClientCall) => {
    calls.contextObservations.push(input);
    return contextResponse;
  }),
  recordEvent: mock(async (input: ClientCall) => {
    calls.recordEvent.push(input);
    return { event: { id: 'event-1', projectId: 'project-1', serverSessionId: null } };
  }),
};

const fallbackLogs: Array<{ reason: string; details?: Record<string, unknown> }> = [];

mock.module('../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => (
    runtimeMode === 'server-beta'
      ? {
          runtime: 'server-beta',
          client: mockClient,
          projectId: 'project-1',
          serverBaseUrl: 'http://server-beta.test',
        }
      : { runtime: 'worker' }
  ),
  logServerBetaFallback: (reason: string, details?: Record<string, unknown>) => {
    fallbackLogs.push({ reason, details });
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  ...realProjectNameSnapshot,
  getProjectContext: () => ({
    primary: 'test-project',
    allProjects: ['test-project', 'linked-project'],
  }),
}));

mock.module('../../src/shared/should-track-project.js', () => ({
  ...realShouldTrackProjectSnapshot,
  shouldTrackProject: () => true,
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    failure: () => {},
    dataIn: () => {},
    formatTool: () => '',
  },
}));

afterAll(() => {
  mock.module('../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/shared/should-track-project.js', () => realShouldTrackProjectSnapshot);
  mock.module('../../src/utils/logger.js', () => realLoggerSnapshot);
});

import { contextHandler } from '../../src/cli/handlers/context.js';
import { sessionInitHandler } from '../../src/cli/handlers/session-init.js';

describe('server-beta Claude Code context injection hooks', () => {
  beforeEach(() => {
    runtimeMode = 'server-beta';
    calls.startSession.length = 0;
    calls.contextObservations.length = 0;
    calls.recordEvent.length = 0;
    fallbackLogs.length = 0;
    contextResponse = {
      observations: [
        { id: 'obs-1', projectId: 'project-1', content: 'alpha' },
        { id: 'obs-2', projectId: 'project-1', content: 'beta' },
      ],
      context: 'alpha\n\nbeta',
    };
    mockClient.startSession.mockClear();
    mockClient.contextObservations.mockClear();
    mockClient.recordEvent.mockClear();
  });

  it('context handler injects recent server-beta context and records a non-generating audit event', async () => {
    const result = await contextHandler.execute({
      sessionId: 'content-session-1',
      cwd: '/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(result.hookSpecificOutput?.additionalContext).toBe('alpha\n\nbeta');
    expect(calls.contextObservations).toEqual([
      { projectId: 'project-1', limit: 10 },
    ]);
    expect(calls.recordEvent).toHaveLength(1);
    expect(calls.recordEvent[0]?.eventType).toBe('context_injection');
    expect(calls.recordEvent[0]?.generate).toBe(false);
    expect(calls.recordEvent[0]?.contentSessionId).toBe('content-session-1');
    expect(calls.recordEvent[0]?.payload).toMatchObject({
      hook_event_name: 'SessionStart',
      query: null,
      result_count: 2,
      context_length: 'alpha\n\nbeta'.length,
      project: 'test-project',
      projects: ['test-project', 'linked-project'],
      platformSource: 'claude',
    });
  });

  it('session-init starts a server-beta session, injects prompt-aware context, and records the context event', async () => {
    const result = await sessionInitHandler.execute({
      sessionId: 'content-session-2',
      cwd: '/repo',
      platform: 'claude-code',
      prompt: 'deployment pipeline is failing',
    });

    expect(result.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(result.hookSpecificOutput?.additionalContext).toBe('alpha\n\nbeta');
    expect(calls.startSession).toHaveLength(1);
    expect(calls.startSession[0]).toMatchObject({
      projectId: 'project-1',
      externalSessionId: 'content-session-2',
      contentSessionId: 'content-session-2',
      platformSource: 'claude',
      metadata: {
        project: 'test-project',
        prompt: 'deployment pipeline is failing',
      },
    });
    expect(calls.contextObservations).toEqual([
      {
        projectId: 'project-1',
        query: 'deployment pipeline is failing',
        limit: 5,
      },
    ]);
    expect(calls.recordEvent).toHaveLength(1);
    expect(calls.recordEvent[0]).toMatchObject({
      projectId: 'project-1',
      contentSessionId: 'content-session-2',
      sourceType: 'hook',
      eventType: 'context_injection',
      generate: false,
    });
    expect(calls.recordEvent[0]?.payload).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      query: 'deployment pipeline is failing',
      result_count: 2,
      context_length: 'alpha\n\nbeta'.length,
    });
  });
});
