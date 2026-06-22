// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../../services/domain/ModeManager.js';
import {
  createPostgresStorageRepositories,
  getSharedPostgresPool,
  SERVER_BETA_POSTGRES_SCHEMA_VERSION,
  type PostgresStorageRepositories,
} from '../../storage/postgres/index.js';
import { bootstrapServerBetaPostgresSchema } from '../../storage/postgres/schema.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import { ActiveServerBetaGenerationWorkerManager } from './ActiveServerBetaGenerationWorkerManager.js';
import { buildServerJobId } from '../jobs/job-id.js';
import {
  assertServerGenerationJobPayload,
  type ServerGenerationJobKind,
  type ServerGenerationJobPayload,
} from '../jobs/types.js';
import { ClaudeObservationProvider } from '../generation/providers/ClaudeObservationProvider.js';
import { ClaudeSdkObservationProvider } from '../generation/providers/ClaudeSdkObservationProvider.js';
import { GeminiObservationProvider } from '../generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
import type {
  ObservationGenerationJobSourceType,
  PostgresObservationGenerationJob,
} from '../../storage/postgres/generation-jobs.js';
import { ServerBetaService } from './ServerBetaService.js';
import {
  DisabledServerBetaGenerationWorkerManager,
  DisabledServerBetaQueueManager,
  type ServerBetaAuthMode,
  type ServerBetaBootstrapStatus,
  type ServerBetaGenerationWorkerManager,
  type ServerBetaQueueManager,
  type ServerBetaServiceGraph,
} from './types.js';

export interface CreateServerBetaServiceOptions {
  pool?: PostgresPool;
  authMode?: ServerBetaAuthMode;
  bootstrapSchema?: boolean;
  queueManager?: ServerBetaQueueManager;
  // Phase 5 seam: tests can inject a fake provider without env config.
  generationProvider?: ServerGenerationProvider;
  generationWorkerManager?: ServerBetaGenerationWorkerManager;
  // Phase 10: when true, skip building the generation worker. Used when the
  // service is just an HTTP front-end and a separate `server worker` process
  // consumes the BullMQ queues.
  generationDisabled?: boolean;
  // Phase 10: skip env validation (tests). Production code paths always run
  // validation so misconfiguration fails fast at startup.
  skipEnvValidation?: boolean;
}

// Phase 10 — env validation. Server beta in Docker requires explicit, complete
// configuration. Missing pieces fail fast at startup rather than silently
// degrading. Required env when running in Docker:
//   - CLAUDE_MEM_SERVER_DATABASE_URL  (Postgres)
//   - CLAUDE_MEM_QUEUE_ENGINE=bullmq  (no in-memory queue in Docker)
//   - CLAUDE_MEM_REDIS_URL            (BullMQ requires Redis/Valkey)
//   - CLAUDE_MEM_AUTH_MODE != local-dev (auth must be real in Docker)
// `local-dev` bypass is only valid on a developer's loopback; in Docker the
// container is reachable via service-to-service networking and exposed ports,
// so the loopback assumption is invalid.
export interface ServerBetaEnvValidationOptions {
  env?: NodeJS.ProcessEnv;
  isDocker?: boolean;
}

export interface ServerBetaEnvValidationResult {
  isDocker: boolean;
  runtime: string;
  authMode: string;
  queueEngine: string;
  hasDatabaseUrl: boolean;
  hasRedisUrl: boolean;
}

export function detectDockerEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDE_MEM_DOCKER === '1' || env.CLAUDE_MEM_DOCKER === 'true') return true;
  // /.dockerenv is the canonical Docker marker; existsSync is cheap.
  try {
    if (existsSync('/.dockerenv')) return true;
  } catch {
    // ignore
  }
  return false;
}

export function validateServerBetaEnv(
  options: ServerBetaEnvValidationOptions = {},
): ServerBetaEnvValidationResult {
  const env = options.env ?? process.env;
  const isDocker = options.isDocker ?? detectDockerEnvironment(env);
  const errors: string[] = [];

  const runtime = (env.CLAUDE_MEM_RUNTIME ?? '').trim();
  if (!runtime) {
    // Warn but allow — defaulted to 'worker' upstream; we log a warning so
    // operators know server-beta is the active runtime here.
    if (isDocker) {
      logger.warn('SYSTEM', 'CLAUDE_MEM_RUNTIME unset; server-beta container assumes runtime=server-beta');
    }
  } else if (runtime !== 'server-beta' && isDocker) {
    errors.push(
      `CLAUDE_MEM_RUNTIME=${runtime} is invalid in Docker; the server-beta image only runs CLAUDE_MEM_RUNTIME=server-beta.`,
    );
  }

  const authMode = (env.CLAUDE_MEM_AUTH_MODE ?? 'api-key').trim();
  if (isDocker) {
    if (authMode === 'local-dev') {
      errors.push(
        'CLAUDE_MEM_AUTH_MODE=local-dev is not allowed in Docker. Set CLAUDE_MEM_AUTH_MODE=api-key and create a key with `claude-mem server api-key create`.',
      );
    }
    if (
      env.CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS === '1'
      || env.CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS === 'true'
    ) {
      errors.push(
        'CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS is not allowed in Docker. Loopback bypass cannot be enforced inside a container; remove the variable.',
      );
    }
  }

  const queueEngine = (env.CLAUDE_MEM_QUEUE_ENGINE ?? '').trim().toLowerCase();
  if (isDocker) {
    if (!queueEngine) {
      errors.push('CLAUDE_MEM_QUEUE_ENGINE is required in Docker; set it to "bullmq".');
    } else if (queueEngine !== 'bullmq') {
      errors.push(
        `CLAUDE_MEM_QUEUE_ENGINE=${queueEngine} is not allowed in Docker. Only "bullmq" is supported (no in-process queues across container boundaries).`,
      );
    }
  }

  const hasDatabaseUrl = Boolean((env.CLAUDE_MEM_SERVER_DATABASE_URL ?? '').trim());
  if (!hasDatabaseUrl) {
    errors.push('CLAUDE_MEM_SERVER_DATABASE_URL is required to start server-beta (Postgres connection string).');
  }

  const hasRedisUrl = Boolean((env.CLAUDE_MEM_REDIS_URL ?? '').trim());
  if (queueEngine === 'bullmq' && !hasRedisUrl) {
    errors.push('CLAUDE_MEM_REDIS_URL is required when CLAUDE_MEM_QUEUE_ENGINE=bullmq.');
  }

  if (errors.length > 0) {
    const message = [
      'server-beta startup configuration is invalid:',
      ...errors.map(line => `  - ${line}`),
    ].join('\n');
    throw new Error(message);
  }

  return {
    isDocker,
    runtime: runtime || 'server-beta',
    authMode,
    queueEngine: queueEngine || 'disabled',
    hasDatabaseUrl,
    hasRedisUrl,
  };
}

// #2443 — the server-beta runtime must load an observation mode before it can
// process any generation job; without it every job fails with "No mode
// loaded". We mirror the worker's pattern (src/services/worker-service.ts) and
// fail fast at boot if no mode can be loaded, so a broken install surfaces at
// startup rather than as silent per-job failures.
export function loadServerBetaMode(): void {
  // ModeManager.loadMode('code') throws ('Critical: code.json mode file
  // missing') if the bundled mode is absent — that propagates as a fatal boot
  // error. We additionally assert a mode is active afterward.
  const modeManager = ModeManager.getInstance();
  modeManager.loadMode('code');
  // getActiveMode() throws if nothing is loaded — this is the explicit
  // validation that boot did not silently no-op.
  modeManager.getActiveMode();
  logger.info('SYSTEM', 'Server beta mode loaded', { mode: 'code' });
}

export async function createServerBetaService(
  options: CreateServerBetaServiceOptions = {},
): Promise<ServerBetaService> {
  // Generation prompt-builder requires an active mode; server-beta never went
  // through the plugin setup path that loads one, so we do it here explicitly.
  try {
    ModeManager.getInstance().loadMode('code');
  } catch (err) {
    // Mode files are optional, but surface failures (e.g. malformed JSON in a
    // CLAUDE_MEM_MODES_DIR file) so an operator can diagnose why custom types
    // aren't appearing instead of silently falling back to the defaults.
    logger.warn('SYSTEM', 'server-beta: failed to load mode at startup (mode files optional)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!options.skipEnvValidation) {
    validateServerBetaEnv();
  }
  // Fail fast if no observation mode can be loaded (#2443). Must happen before
  // the service starts accepting jobs.
  loadServerBetaMode();
  const pool = options.pool ?? getSharedPostgresPool({ requireDatabaseUrl: true });
  const bootstrap = await initializePostgres(pool, options.bootstrapSchema ?? true);
  const queueManager = options.queueManager ?? buildQueueManager();
  const storage = createPostgresStorageRepositories(pool);
  const generationDisabled = options.generationDisabled
    ?? (process.env.CLAUDE_MEM_GENERATION_DISABLED === '1'
      || process.env.CLAUDE_MEM_GENERATION_DISABLED === 'true');
  const generationWorkerManager = options.generationWorkerManager
    ?? (generationDisabled
      ? new DisabledServerBetaGenerationWorkerManager(
          'CLAUDE_MEM_GENERATION_DISABLED is set; this server runs HTTP only. A separate `claude-mem server worker start` process consumes the BullMQ queues.',
        )
      : buildGenerationWorkerManager(pool, queueManager, options.generationProvider));
  const graph: ServerBetaServiceGraph = {
    runtime: 'server-beta',
    postgres: {
      pool,
      bootstrap,
    },
    authMode: options.authMode ?? parseAuthMode(process.env.CLAUDE_MEM_AUTH_MODE),
    queueManager,
    generationWorkerManager,
    storage,
  };

  if (generationWorkerManager instanceof ActiveServerBetaGenerationWorkerManager) {
    if (queueManager instanceof ActiveServerBetaQueueManager) {
      await reconcileServerBetaOutboxOnWorkerStartup(pool, queueManager, storage);
    }
    generationWorkerManager.start();
  }

  return new ServerBetaService({ graph });
}

async function reconcileServerBetaOutboxOnWorkerStartup(
  pool: PostgresPool,
  queueManager: ActiveServerBetaQueueManager,
  storage: PostgresStorageRepositories,
): Promise<void> {
  const scopeResult = await pool.query<{ team_id: string; project_id: string }>(
    `
      SELECT DISTINCT team_id, project_id
      FROM observation_generation_jobs
      WHERE status IN ('queued', 'processing')
        AND attempts < max_attempts
      ORDER BY team_id, project_id
    `,
  );
  if (scopeResult.rows.length === 0) {
    return;
  }

  const lanes: Array<{
    kind: Extract<ServerGenerationJobKind, 'event' | 'summary'>;
    sourceTypes: ObservationGenerationJobSourceType[];
  }> = [
    { kind: 'event', sourceTypes: ['agent_event'] },
    { kind: 'summary', sourceTypes: ['session_summary'] },
  ];
  let totalRequeued = 0;
  let totalSkipped = 0;

  for (const scope of scopeResult.rows) {
    for (const lane of lanes) {
      try {
        const result = await reconcileStartupGenerationJobs(
          storage,
          queueManager.getQueue(lane.kind),
          {
            projectId: scope.project_id,
            teamId: scope.team_id,
          },
          lane.sourceTypes,
          lane.kind,
        );
        totalRequeued += result.requeued;
        totalSkipped += result.skipped;
      } catch (error) {
        logger.warn('QUEUE', 'server-beta startup reconciliation failed for lane', {
          teamId: scope.team_id,
          projectId: scope.project_id,
          lane: lane.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.info('QUEUE', 'server-beta startup reconciliation completed', {
    scopes: scopeResult.rows.length,
    requeued: totalRequeued,
    skipped: totalSkipped,
  });
}

async function reconcileStartupGenerationJobs(
  storage: PostgresStorageRepositories,
  queue: ReturnType<ActiveServerBetaQueueManager['getQueue']>,
  scope: { projectId: string; teamId: string },
  sourceTypes: ObservationGenerationJobSourceType[],
  expectedKind: Extract<ServerGenerationJobKind, 'event' | 'summary'>,
): Promise<{ requeued: number; skipped: number }> {
  const limit = 500;
  const queued = await storage.observationGenerationJobs.listByStatusForScope({
    status: 'queued',
    projectId: scope.projectId,
    teamId: scope.teamId,
    sourceTypes,
    limit,
  });
  const processing = await storage.observationGenerationJobs.listByStatusForScope({
    status: 'processing',
    projectId: scope.projectId,
    teamId: scope.teamId,
    sourceTypes,
    limit,
  });

  let requeued = 0;
  let skipped = 0;
  for (const row of [...processing, ...queued]) {
    const result = await reconcileStartupGenerationJob(storage, queue, row, expectedKind);
    if (result === 'requeued') {
      requeued += 1;
    } else {
      skipped += 1;
    }
  }
  return { requeued, skipped };
}

async function reconcileStartupGenerationJob(
  storage: PostgresStorageRepositories,
  queue: ReturnType<ActiveServerBetaQueueManager['getQueue']>,
  row: PostgresObservationGenerationJob,
  expectedKind: Extract<ServerGenerationJobKind, 'event' | 'summary'>,
): Promise<'requeued' | 'skipped'> {
  if (row.attempts >= row.maxAttempts) {
    return 'skipped';
  }

  let payload: ServerGenerationJobPayload;
  try {
    payload = assertServerGenerationJobPayload(row.payload);
  } catch (error) {
    logger.warn('QUEUE', 'server-beta startup reconciliation skipped invalid persisted payload', {
      jobId: row.id,
      sourceType: row.sourceType,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'skipped';
  }

  if (payload.kind !== expectedKind) {
    logger.warn('QUEUE', 'server-beta startup reconciliation skipped payload for wrong queue lane', {
      jobId: row.id,
      expectedKind,
      actualKind: payload.kind,
    });
    return 'skipped';
  }

  const bullmqJobId = row.bullmqJobId ?? buildServerJobId({
    kind: payload.kind,
    team_id: payload.team_id,
    project_id: payload.project_id,
    source_type: payload.source_type,
    source_id: payload.source_id,
  });

  try {
    await queue.remove(bullmqJobId);
  } catch (error) {
    logger.debug?.('QUEUE', `remove before startup re-add ignored for ${bullmqJobId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let current = row;
  if (row.status === 'processing') {
    const demoted = await storage.observationGenerationJobs.transitionStatus({
      id: row.id,
      projectId: row.projectId,
      teamId: row.teamId,
      status: 'queued',
    });
    if (!demoted) {
      return 'skipped';
    }
    current = demoted;
    await storage.observationGenerationJobEvents.append({
      generationJobId: current.id,
      projectId: current.projectId,
      teamId: current.teamId,
      eventType: 'queued',
      statusAfter: 'queued',
      attempt: current.attempts,
      details: { source: 'reconcile_on_startup' },
    });
  }

  await queue.add(bullmqJobId, payload);
  await storage.observationGenerationJobEvents.append({
    generationJobId: current.id,
    projectId: current.projectId,
    teamId: current.teamId,
    eventType: 'enqueued',
    statusAfter: 'queued',
    attempt: current.attempts,
    details: { source: 'reconcile_on_startup' },
  });
  return 'requeued';
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerBetaQueueManager,
  injectedProvider?: ServerGenerationProvider,
): ServerBetaGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerBetaQueueManager)) {
    return new DisabledServerBetaGenerationWorkerManager(
      'queue manager is disabled; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    return new DisabledServerBetaGenerationWorkerManager(
      'no server generation provider configured; set CLAUDE_MEM_SERVER_PROVIDER and the matching auth credentials to enable.',
    );
  }
  return new ActiveServerBetaGenerationWorkerManager({
    pool,
    queueManager,
    provider,
  });
}

function buildServerGenerationProviderFromEnv(): ServerGenerationProvider | null {
  const provider = (process.env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return null;
  try {
    if (provider === 'claude' || provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '';
      const authMethod = resolveServerClaudeAuthMethod(apiKey);
      const model = process.env.CLAUDE_MEM_SERVER_MODEL;
      if (authMethod === 'api-key') {
        if (!apiKey) return null;
        const opts: { apiKey: string; model?: string } = { apiKey };
        if (model) opts.model = model;
        return new ClaudeObservationProvider(opts);
      }
      if (authMethod === 'subscription' || authMethod === 'cli' || authMethod === 'oauth') {
        return new ClaudeSdkObservationProvider(model ? { model } : {});
      }
      return null;
    }
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string } = { apiKey };
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      return new GeminiObservationProvider(opts);
    }
    if (provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.CLAUDE_MEM_OPENROUTER_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string; baseUrl?: string } = { apiKey };
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL.
      const baseUrl = process.env.CLAUDE_MEM_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL;
      if (baseUrl) opts.baseUrl = baseUrl;
      return new OpenRouterObservationProvider(opts);
    }
  } catch (error) {
    logger.warn(
      'SYSTEM',
      'server-beta generation provider configuration failed',
      { provider },
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
  return null;
}

function resolveServerClaudeAuthMethod(apiKey: string): 'api-key' | 'subscription' | 'cli' | 'oauth' | 'unknown' {
  const raw = (
    process.env.CLAUDE_MEM_SERVER_CLAUDE_AUTH_METHOD ??
    process.env.CLAUDE_MEM_CLAUDE_AUTH_METHOD ??
    ''
  ).trim().toLowerCase();

  if (raw === 'api-key' || raw === 'api_key' || raw === 'anthropic-api-key') return 'api-key';
  if (raw === 'subscription' || raw === 'pro') return 'subscription';
  if (raw === 'cli' || raw === 'claude-code') return 'cli';
  if (raw === 'oauth' || raw === 'claude-code-oauth') return 'oauth';

  // Preserve API-key behavior when a key is explicitly present, but make the
  // no-key Claude path useful for server-beta subscription deployments.
  if (!raw) return apiKey ? 'api-key' : 'subscription';
  return 'unknown';
}

// Queue manager selection is fail-fast on misconfiguration. If the user
// explicitly opts into BullMQ via CLAUDE_MEM_QUEUE_ENGINE=bullmq we build
// the active manager; any error there throws so the runtime does not
// silently fall back to a disabled queue. Default behavior (sqlite engine
// or no opt-in) keeps the disabled boundary so worker-era runtimes stay
// compatible.
function buildQueueManager(): ServerBetaQueueManager {
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') {
    return new DisabledServerBetaQueueManager(
      `Queue engine is "${config.engine}"; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to activate the server-beta queue manager.`,
    );
  }
  return new ActiveServerBetaQueueManager(config);
}

async function initializePostgres(pool: PostgresPool, bootstrapSchema: boolean): Promise<ServerBetaBootstrapStatus> {
  if (!bootstrapSchema) {
    return { initialized: false, schemaVersion: null, appliedAt: null };
  }

  await bootstrapServerBetaPostgresSchema(pool);
  const result = await pool.query(
    `
      SELECT version, applied_at
      FROM server_beta_schema_migrations
      WHERE version = $1
    `,
    [SERVER_BETA_POSTGRES_SCHEMA_VERSION],
  );
  const row = result.rows[0] as { version?: number; applied_at?: Date | string } | undefined;

  return {
    initialized: row?.version === SERVER_BETA_POSTGRES_SCHEMA_VERSION,
    schemaVersion: typeof row?.version === 'number' ? row.version : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

function parseAuthMode(value: string | undefined): ServerBetaAuthMode {
  if (value === 'local-dev' || value === 'disabled') {
    return value;
  }
  return 'api-key';
}
