// SPDX-License-Identifier: Apache-2.0
//
// Server-beta compatibility API for the existing Viewer UI.
//
// The React viewer was built against the in-plugin worker's SQLite-backed
// `/api/*` routes. Server-beta stores the same concepts in Postgres, so this
// route layer maps the Postgres schema into the legacy viewer shape without
// changing the UI bundle.

import type { Application, Request, Response } from 'express';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'fs';
import path from 'path';
import type { QueryResultRow } from 'pg';
import type { RouteHandler } from '../../services/server/Server.js';
import { getPackageRoot, paths } from '../../shared/paths.js';
import { getJapanesePromptDisplayText } from '../../shared/prompt-display-summary.js';
import { normalizeProjectDisplayName } from '../../shared/project-display-name.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
import { getUptimeSeconds } from '../../shared/uptime.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { logger } from '../../utils/logger.js';
import { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import type { ServerBetaQueueLaneMetric, ServerBetaQueueManager } from './types.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const SERVER_BETA_RUNTIME = 'server-beta';
const SENSITIVE_SETTING_KEYS = new Set([
  'CLAUDE_MEM_SERVER_BETA_API_KEY',
]);

const USER_EDITABLE_SETTING_KEYS = [
  'CLAUDE_MEM_MODEL',
  'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
  'CLAUDE_MEM_WORKER_PORT',
  'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_CLAUDE_AUTH_METHOD',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_GEMINI_MODEL',
  'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
  'CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES',
  'CLAUDE_MEM_GEMINI_MAX_TOKENS',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_OPENROUTER_SITE_URL',
  'CLAUDE_MEM_OPENROUTER_APP_NAME',
  'CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES',
  'CLAUDE_MEM_OPENROUTER_MAX_TOKENS',
  'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_LOG_LEVEL',
  'CLAUDE_MEM_PYTHON_VERSION',
  'CLAUDE_CODE_PATH',
  'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
  'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
  'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
  'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
  'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
  'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
  'CLAUDE_MEM_CONTEXT_FULL_COUNT',
  'CLAUDE_MEM_CONTEXT_FULL_FIELD',
  'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
  'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
  'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
  'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED',
] as const;

function normalizedProjectSql(rawExpression: string): string {
  const trimmed = `btrim(COALESCE(${rawExpression}, ''))`;
  return `
    CASE
      WHEN ${trimmed} = 'SEOUP' THEN 'HPShuttle'
      WHEN ${trimmed} = 'ホームページシャトル' THEN 'HPShuttle'
      WHEN ${trimmed} = '' THEN NULL
      ELSE ${trimmed}
    END
  `;
}

const OBSERVATION_PROJECT_SQL = normalizedProjectSql(`
  COALESCE(
    NULLIF(ss.metadata->>'project', ''),
    NULLIF(p.metadata->>'project', ''),
    p.name
  )
`);

const SESSION_PROJECT_SQL = normalizedProjectSql(`
  COALESCE(
    NULLIF(ss.metadata->>'project', ''),
    NULLIF(p.metadata->>'project', ''),
    p.name
  )
`);

function normalizedPlatformSql(rawExpression: string): string {
  const cleaned = `lower(replace(btrim(COALESCE(${rawExpression}, 'claude')), ' ', '-'))`;
  return `
    CASE
      WHEN ${cleaned} = '' THEN 'claude'
      WHEN ${cleaned} = 'transcript' OR ${cleaned} LIKE '%codex%' THEN 'codex'
      WHEN ${cleaned} LIKE '%cursor%' THEN 'cursor'
      WHEN ${cleaned} LIKE '%claude%' THEN 'claude'
      ELSE ${cleaned}
    END
  `;
}

const OBSERVATION_FALLBACK_PLATFORM_SQL = normalizedPlatformSql(
  "COALESCE(ss.platform_source, o.metadata->>'platform_source', o.metadata->>'provider', 'claude')",
);
const SESSION_PLATFORM_SQL = normalizedPlatformSql(
  "COALESCE(ss.platform_source, 'claude')",
);

interface ServerViewerApiRoutesOptions {
  pool: PostgresPool;
  queueManager: ServerBetaQueueManager;
  startTimeMs: number;
}

interface PaginationParams {
  offset: number;
  limit: number;
  project: string | null;
  platformSource: string | null;
}

interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

interface LegacyObservation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

interface LegacySummary {
  id: number;
  session_id: string;
  project: string;
  platform_source: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
}

interface LegacyPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

interface ObservationRow extends QueryResultRow {
  viewer_id: number | string;
  postgres_id: string;
  memory_session_id: string | null;
  project: string | null;
  platform_source: string | null;
  kind: string;
  content: string;
  metadata: unknown;
  created_at: Date | string;
  created_at_epoch: number | string;
}

interface PromptRow extends QueryResultRow {
  viewer_id: number | string;
  content_session_id: string | null;
  project: string | null;
  platform_source: string | null;
  prompt_number: number | string | null;
  prompt_text: string | null;
  prompt_summary_ja: string | null;
  created_at: Date | string;
  created_at_epoch: number | string;
}

interface ProjectCatalogRow extends QueryResultRow {
  project: string | null;
  platform_source: string | null;
}

export class ServerViewerApiRoutes implements RouteHandler {
  private readonly pool: PostgresPool;
  private readonly queueManager: ServerBetaQueueManager;
  private readonly startTimeMs: number;
  private sseClientCount = 0;

  constructor(options: ServerViewerApiRoutesOptions) {
    this.pool = options.pool;
    this.queueManager = options.queueManager;
    this.startTimeMs = options.startTimeMs;
  }

  setupRoutes(app: Application): void {
    app.get('/api/observations', this.asyncRoute(this.handleGetObservations));
    app.get('/api/summaries', this.asyncRoute(this.handleGetSummaries));
    app.get('/api/prompts', this.asyncRoute(this.handleGetPrompts));
    app.get('/api/projects', this.asyncRoute(this.handleGetProjects));
    app.get('/api/stats', this.asyncRoute(this.handleGetStats));
    app.get('/api/processing-status', this.asyncRoute(this.handleGetProcessingStatus));
    app.get('/api/context/preview', this.asyncRoute(this.handleContextPreview));
    app.get('/api/settings', this.handleGetSettings);
    app.post('/api/settings', this.handleUpdateSettings);
    app.get('/api/logs', this.handleGetLogs);
    app.post('/api/logs/clear', this.handleClearLogs);
    app.get('/api/onboarding/explainer', this.handleOnboardingExplainer);
    app.get('/stream', this.asyncRoute(this.handleSseStream));
  }

  private asyncRoute(
    handler: (req: Request, res: Response) => Promise<void>,
  ): (req: Request, res: Response, next: (error?: unknown) => void) => void {
    return (req, res, next) => {
      handler.call(this, req, res).catch(next);
    };
  }

  private handleGetSettings = (_req: Request, res: Response): void => {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    res.json(this.sanitizeSettings(settings));
  };

  private handleUpdateSettings = (req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    const current = { ...SettingsDefaultsManager.loadFromFile(settingsPath, false) } as Record<string, string>;
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};

    for (const key of USER_EDITABLE_SETTING_KEYS) {
      if (body[key] !== undefined && typeof body[key] !== 'object') {
        current[key] = String(body[key]);
      }
    }

    writeFileSync(settingsPath, JSON.stringify(current, null, 2), 'utf-8');
    res.json({ success: true, message: 'Settings updated successfully' });
  };

  private async handleGetObservations(req: Request, res: Response): Promise<void> {
    const params = this.parsePaginationParams(req);
    const rows = await this.queryObservationRows(params, 'observation');
    const items = rows.slice(0, params.limit).map(row => this.mapObservationRow(row));
    res.json(this.paginated(items, rows.length > params.limit, params));
  }

  private async handleGetSummaries(req: Request, res: Response): Promise<void> {
    const params = this.parsePaginationParams(req);
    const rows = await this.queryObservationRows(params, 'summary');
    const items = rows.slice(0, params.limit).map(row => this.mapSummaryRow(row));
    res.json(this.paginated(items, rows.length > params.limit, params));
  }

  private async handleGetPrompts(req: Request, res: Response): Promise<void> {
    const params = this.parsePaginationParams(req);
    const rows = await this.queryPromptRows(params);
    const items = rows.slice(0, params.limit).map(row => this.mapPromptRow(row));
    res.json(this.paginated(items, rows.length > params.limit, params));
  }

  private async handleGetProjects(req: Request, res: Response): Promise<void> {
    const requestedPlatform = optionalString(req.query.platformSource);
    const platformSource = requestedPlatform ? normalizePlatformSource(requestedPlatform) : null;
    const catalog = await this.getProjectCatalog(platformSource);
    res.json(catalog);
  }

  private async handleGetStats(_req: Request, res: Response): Promise<void> {
    const packageJson = JSON.parse(readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8')) as { version?: string };
    const counts = await this.pool.query<{
      observations: string;
      sessions: string;
      summaries: string;
      first_observation_at: Date | null;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM observations WHERE kind <> 'summary')::text AS observations,
        (SELECT COUNT(*) FROM server_sessions)::text AS sessions,
        (SELECT COUNT(*) FROM observations WHERE kind = 'summary')::text AS summaries,
        (SELECT MIN(created_at) FROM observations) AS first_observation_at
    `);
    const row = counts.rows[0]!;

    res.json({
      worker: {
        version: packageJson.version ?? 'development',
        runtime: SERVER_BETA_RUNTIME,
        uptime: getUptimeSeconds(this.startTimeMs),
        activeSessions: 0,
        sseClients: this.sseClientCount,
        port: Number(process.env.CLAUDE_MEM_SERVER_PORT ?? 37877),
      },
      database: {
        path: 'postgres',
        size: 0,
        observations: Number(row.observations),
        sessions: Number(row.sessions),
        summaries: Number(row.summaries),
        firstObservationAt: row.first_observation_at ? toIso(row.first_observation_at) : null,
      },
    });
  }

  private async handleGetProcessingStatus(_req: Request, res: Response): Promise<void> {
    res.json(await this.getProcessingStatus());
  }

  private async handleContextPreview(req: Request, res: Response): Promise<void> {
    const project = optionalString(req.query.project);
    if (!project) {
      res.status(400).send('Project parameter is required');
      return;
    }
    const platformSource = optionalString(req.query.platformSource);
    const normalizedPlatform = platformSource ? normalizePlatformSource(platformSource) : null;
    const text = await this.buildContextPreview(project, normalizedPlatform);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  }

  private handleGetLogs = (req: Request, res: Response): void => {
    const logFilePath = this.getLogFilePath();
    if (!existsSync(logFilePath)) {
      res.json({ logs: '', path: logFilePath, exists: false });
      return;
    }

    const requestedLines = parseInt(optionalString(req.query.lines) ?? '1000', 10);
    const maxLines = Math.min(Number.isFinite(requestedLines) ? requestedLines : 1000, 10000);
    const { lines, totalEstimate } = readLastLines(logFilePath, maxLines);
    res.json({
      logs: lines,
      path: logFilePath,
      exists: true,
      totalLines: totalEstimate,
      returnedLines: lines === '' ? 0 : lines.split('\n').length,
    });
  };

  private handleClearLogs = (_req: Request, res: Response): void => {
    const logFilePath = this.getLogFilePath();
    if (!existsSync(logFilePath)) {
      res.json({ success: true, message: 'Log file does not exist', path: logFilePath });
      return;
    }

    writeFileSync(logFilePath, '', 'utf-8');
    logger.info('SYSTEM', 'Server-beta viewer log file cleared via UI', { path: logFilePath });
    res.json({ success: true, message: 'Log file cleared', path: logFilePath });
  };

  private handleOnboardingExplainer = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(`# claude-mem server-beta

This viewer is served by the server-beta runtime and reads memory from Postgres.

Observation generation is running through the configured Claude Code subscription auth path when the provider is set to Claude subscription mode.
`);
  };

  private async handleSseStream(_req: Request, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    this.sseClientCount += 1;

    const writeEvent = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const catalog = await this.getProjectCatalog(null);
    writeEvent({
      type: 'initial_load',
      projects: catalog.projects,
      sources: catalog.sources,
      projectsBySource: catalog.projectsBySource,
      timestamp: Date.now(),
    });
    writeEvent({
      type: 'processing_status',
      ...(await this.getProcessingStatus()),
    });

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClientCount = Math.max(0, this.sseClientCount - 1);
    });
  }

  private parsePaginationParams(req: Request): PaginationParams {
    const offsetRaw = parseInt(optionalString(req.query.offset) ?? '0', 10);
    const limitRaw = parseInt(optionalString(req.query.limit) ?? String(DEFAULT_PAGE_SIZE), 10);
    const requestedProject = optionalString(req.query.project);
    const requestedPlatform = optionalString(req.query.platformSource);

    return {
      offset: Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0),
      limit: Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
      project: normalizeProjectDisplayName(requestedProject),
      platformSource: requestedPlatform ? normalizePlatformSource(requestedPlatform) : null,
    };
  }

  private paginated<T>(
    items: T[],
    hasMore: boolean,
    params: PaginationParams,
  ): PaginatedResult<T> {
    return {
      items,
      hasMore,
      offset: params.offset,
      limit: params.limit,
    };
  }

  private async queryObservationRows(
    params: PaginationParams,
    mode: 'observation' | 'summary',
  ): Promise<ObservationRow[]> {
    const kindCondition = mode === 'summary'
      ? "o.kind = 'summary'"
      : "o.kind <> 'summary'";

    const result = await this.pool.query<ObservationRow>(
      `
        WITH mapped AS (
          SELECT
            (row_number() OVER (ORDER BY o.created_at ASC, o.id ASC))::integer AS viewer_id,
            o.id AS postgres_id,
            COALESCE(ss.content_session_id, ss.external_session_id, ss.id, o.server_session_id, '') AS memory_session_id,
            ${OBSERVATION_PROJECT_SQL} AS project,
            ${OBSERVATION_FALLBACK_PLATFORM_SQL} AS platform_source,
            o.kind,
            o.content,
            o.metadata,
            o.created_at,
            floor(extract(epoch FROM o.created_at) * 1000)::bigint AS created_at_epoch
          FROM observations o
          JOIN projects p ON p.id = o.project_id
          LEFT JOIN server_sessions ss ON ss.id = o.server_session_id
          WHERE ${kindCondition}
        )
        SELECT *
        FROM mapped
        WHERE ($1::text IS NULL OR project = $1)
          AND ($2::text IS NULL OR platform_source = $2)
        ORDER BY created_at DESC, postgres_id DESC
        LIMIT $3 OFFSET $4
      `,
      [params.project, params.platformSource, params.limit + 1, params.offset],
    );
    return result.rows;
  }

  private async queryPromptRows(params: PaginationParams): Promise<PromptRow[]> {
    const result = await this.pool.query<PromptRow>(
      `
        WITH mapped AS (
          SELECT
            (row_number() OVER (ORDER BY ss.started_at ASC, ss.id ASC))::integer AS viewer_id,
            COALESCE(ss.content_session_id, ss.external_session_id, ss.id, '') AS content_session_id,
            ${SESSION_PROJECT_SQL} AS project,
            ${SESSION_PLATFORM_SQL} AS platform_source,
            (row_number() OVER (
              PARTITION BY COALESCE(ss.content_session_id, ss.external_session_id, ss.id)
              ORDER BY ss.started_at ASC, ss.id ASC
            ))::integer AS prompt_number,
            ss.metadata->>'prompt' AS prompt_text,
            ss.metadata->>'prompt_summary_ja' AS prompt_summary_ja,
            ss.started_at AS created_at,
            floor(extract(epoch FROM ss.started_at) * 1000)::bigint AS created_at_epoch
          FROM server_sessions ss
          JOIN projects p ON p.id = ss.project_id
          WHERE NULLIF(ss.metadata->>'prompt', '') IS NOT NULL
        )
        SELECT *
        FROM mapped
        WHERE ($1::text IS NULL OR project = $1)
          AND ($2::text IS NULL OR platform_source = $2)
        ORDER BY created_at DESC, content_session_id DESC
        LIMIT $3 OFFSET $4
      `,
      [params.project, params.platformSource, params.limit + 1, params.offset],
    );
    return result.rows;
  }

  private mapObservationRow(row: ObservationRow): LegacyObservation {
    const metadata = toRecord(row.metadata);
    const narrative = stringOrNull(metadata.narrative) ?? row.content;
    return {
      id: Number(row.viewer_id),
      memory_session_id: row.memory_session_id ?? '',
      project: normalizeProjectDisplayName(row.project) ?? 'unknown-project',
      merged_into_project: null,
      platform_source: row.platform_source ?? 'claude',
      type: row.kind || 'observation',
      title: stringOrNull(metadata.title) ?? firstLine(row.content),
      subtitle: stringOrNull(metadata.subtitle),
      narrative,
      text: row.content,
      facts: jsonArrayString(metadata.facts),
      concepts: jsonArrayString(metadata.concepts),
      files_read: jsonArrayString(metadata.files_read),
      files_modified: jsonArrayString(metadata.files_modified),
      prompt_number: null,
      created_at: toIso(row.created_at),
      created_at_epoch: Number(row.created_at_epoch),
    };
  }

  private mapSummaryRow(row: ObservationRow): LegacySummary {
    const metadata = toRecord(row.metadata);
    return {
      id: Number(row.viewer_id),
      session_id: row.memory_session_id ?? '',
      project: normalizeProjectDisplayName(row.project) ?? 'unknown-project',
      platform_source: row.platform_source ?? 'claude',
      request: stringOrNull(metadata.request),
      investigated: stringOrNull(metadata.investigated),
      learned: stringOrNull(metadata.learned),
      completed: stringOrNull(metadata.completed),
      next_steps: stringOrNull(metadata.next_steps),
      created_at: toIso(row.created_at),
      created_at_epoch: Number(row.created_at_epoch),
    };
  }

  private mapPromptRow(row: PromptRow): LegacyPrompt {
    return {
      id: Number(row.viewer_id),
      content_session_id: row.content_session_id ?? '',
      project: normalizeProjectDisplayName(row.project) ?? 'unknown-project',
      platform_source: row.platform_source ?? 'claude',
      prompt_number: Number(row.prompt_number ?? 1),
      prompt_text: getJapanesePromptDisplayText({
        promptText: row.prompt_text ?? '',
        storedSummaryJa: row.prompt_summary_ja,
      }),
      created_at: toIso(row.created_at),
      created_at_epoch: Number(row.created_at_epoch),
    };
  }

  private async getProjectCatalog(platformSource: string | null): Promise<{
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  }> {
    const result = await this.pool.query<ProjectCatalogRow>(
      `
        WITH raw_catalog AS (
          SELECT
            ${SESSION_PROJECT_SQL} AS project,
            ${SESSION_PLATFORM_SQL} AS platform_source
          FROM server_sessions ss
          JOIN projects p ON p.id = ss.project_id
          UNION
          SELECT
            ${OBSERVATION_PROJECT_SQL} AS project,
            ${OBSERVATION_FALLBACK_PLATFORM_SQL} AS platform_source
          FROM observations o
          JOIN projects p ON p.id = o.project_id
          LEFT JOIN server_sessions ss ON ss.id = o.server_session_id
          UNION
          SELECT
            p.name AS project,
            'claude' AS platform_source
          FROM projects p
        )
        SELECT DISTINCT project, platform_source
        FROM raw_catalog
        WHERE project IS NOT NULL
          AND project <> ''
          AND ($1::text IS NULL OR platform_source = $1)
        ORDER BY project ASC, platform_source ASC
      `,
      [platformSource],
    );

    const projectsBySource: Record<string, string[]> = {};
    const projectSet = new Set<string>();
    const sourceSet = new Set<string>();

    for (const row of result.rows) {
      const project = normalizeProjectDisplayName(row.project);
      if (!project) continue;
      const source = normalizePlatformSource(row.platform_source);
      projectSet.add(project);
      sourceSet.add(source);
      projectsBySource[source] ??= [];
      if (!projectsBySource[source].includes(project)) {
        projectsBySource[source].push(project);
      }
    }

    for (const source of Object.keys(projectsBySource)) {
      projectsBySource[source].sort((a, b) => a.localeCompare(b));
    }

    return {
      projects: Array.from(projectSet).sort((a, b) => a.localeCompare(b)),
      sources: sortPlatformSources(Array.from(sourceSet)),
      projectsBySource,
    };
  }

  private async getProcessingStatus(): Promise<{ isProcessing: boolean; queueDepth: number }> {
    const dbCounts = await this.pool.query<{ status: string; count: string }>(
      `
        SELECT status, COUNT(*)::text AS count
        FROM observation_generation_jobs
        WHERE status IN ('queued', 'processing')
        GROUP BY status
      `,
    );
    const queuedInDb = dbCounts.rows.reduce((sum, row) => sum + Number(row.count), 0);
    const processingInDb = dbCounts.rows
      .filter(row => row.status === 'processing')
      .reduce((sum, row) => sum + Number(row.count), 0);
    const laneMetrics = await this.getQueueLaneMetrics();
    const queuedInBull = laneMetrics.reduce((sum, lane) => {
      if (lane.unavailable) return sum;
      return sum + lane.waiting + lane.active + lane.delayed;
    }, 0);
    const queueDepth = Math.max(queuedInDb, queuedInBull);

    return {
      isProcessing: processingInDb > 0 || queueDepth > 0,
      queueDepth,
    };
  }

  private async getQueueLaneMetrics(): Promise<ServerBetaQueueLaneMetric[]> {
    if (!(this.queueManager instanceof ActiveServerBetaQueueManager)) {
      return [];
    }
    try {
      return await this.queueManager.getLaneMetrics();
    } catch {
      return [];
    }
  }

  private async buildContextPreview(project: string, platformSource: string | null): Promise<string> {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const observationLimit = boundedInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 50, 1, 200);
    const summaryLimit = boundedInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10, 1, 50);
    const params: PaginationParams = {
      offset: 0,
      limit: observationLimit,
      project,
      platformSource,
    };
    const [observations, summaries] = await Promise.all([
      this.queryObservationRows(params, 'observation'),
      this.queryObservationRows({ ...params, limit: summaryLimit }, 'summary'),
    ]);

    if (observations.length === 0 && summaries.length === 0) {
      return `# 過去セッションのメモリーコンテキスト\n\nプロジェクト "${project}" の過去セッションは見つかりませんでした。`;
    }

    const lines: string[] = [
      '# 過去セッションのメモリーコンテキスト',
      '',
      `プロジェクト: ${project}`,
      ...(platformSource ? [`ソース: ${platformSource}`] : []),
      '',
    ];

    if (summaries.length > 0) {
      lines.push('## 最近の要約');
      for (const summary of summaries.slice(0, summaryLimit).map(row => this.mapSummaryRow(row))) {
        lines.push('', `### ${summary.request ?? 'セッション要約'}`);
        if (summary.investigated) lines.push(`調査: ${summary.investigated}`);
        if (summary.learned) lines.push(`学び: ${summary.learned}`);
        if (summary.completed) lines.push(`完了: ${summary.completed}`);
        if (summary.next_steps) lines.push(`次の対応: ${summary.next_steps}`);
      }
      lines.push('');
    }

    if (observations.length > 0) {
      lines.push('## 最近の観測');
      for (const observation of observations.slice(0, observationLimit).map(row => this.mapObservationRow(row))) {
        lines.push('', `- [${observation.type}] ${observation.title ?? '無題'}`);
        if (observation.subtitle) lines.push(`  ${observation.subtitle}`);
        if (observation.narrative) lines.push(`  ${observation.narrative}`);
        const facts = parseJsonArray(observation.facts);
        for (const fact of facts.slice(0, 5)) {
          lines.push(`  - ${String(fact)}`);
        }
      }
    }

    return lines.join('\n').trimEnd();
  }

  private sanitizeSettings(settings: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): Record<string, string> {
    const sanitized: Record<string, string> = { ...settings };
    for (const key of SENSITIVE_SETTING_KEYS) {
      if (sanitized[key]) {
        sanitized[key] = '';
      }
    }
    sanitized.CLAUDE_MEM_RUNTIME = SERVER_BETA_RUNTIME;
    sanitized.CLAUDE_MEM_PROVIDER = sanitized.CLAUDE_MEM_PROVIDER || 'claude';
    sanitized.CLAUDE_MEM_CLAUDE_AUTH_METHOD = sanitized.CLAUDE_MEM_CLAUDE_AUTH_METHOD || 'subscription';
    return sanitized;
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(paths.logsDir(), `claude-mem-${date}.log`);
  }
}

function optionalString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return typeof value === 'string' ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function jsonArrayString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? JSON.stringify(parsed) : JSON.stringify([trimmed]);
    } catch {
      return JSON.stringify([trimmed]);
    }
  }
  return JSON.stringify([String(value)]);
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/, 1)[0]?.trim();
  if (!line) {
    return null;
  }
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function readLastLines(filePath: string, lineCount: number): { lines: string; totalEstimate: number } {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) {
      return { lines: '', totalEstimate: 0 };
    }

    const initialChunkSize = 64 * 1024;
    const maxReadSize = 10 * 1024 * 1024;
    let readSize = Math.min(initialChunkSize, fileSize);
    let content = '';
    let newlineCount = 0;

    while (readSize <= fileSize && readSize <= maxReadSize) {
      const startPosition = Math.max(0, fileSize - readSize);
      const bytesToRead = fileSize - startPosition;
      const buffer = Buffer.alloc(bytesToRead);
      readSync(fd, buffer, 0, bytesToRead, startPosition);
      content = buffer.toString('utf-8');

      newlineCount = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') newlineCount++;
      }

      if (newlineCount >= lineCount || startPosition === 0) {
        break;
      }
      readSize = Math.min(readSize * 2, fileSize, maxReadSize);
    }

    const allLines = content.split('\n');
    if (allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const startIndex = Math.max(0, allLines.length - lineCount);
    const lines = allLines.slice(startIndex);
    const totalEstimate = fileSize <= readSize
      ? allLines.length
      : Math.round(fileSize / Math.max(content.length / Math.max(newlineCount, 1), 1));

    return { lines: lines.join('\n'), totalEstimate };
  } finally {
    closeSync(fd);
  }
}
