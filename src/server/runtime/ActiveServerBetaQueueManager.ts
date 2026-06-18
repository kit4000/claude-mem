// SPDX-License-Identifier: Apache-2.0

import type { Processor } from 'bullmq';
import { ServerJobQueue } from '../jobs/ServerJobQueue.js';
import {
  SERVER_JOB_QUEUE_NAMES,
  type ServerGenerationJobKind,
  type ServerGenerationJobPayload,
} from '../jobs/types.js';
import type { RedisQueueConfig } from '../queue/redis-config.js';
import { logger } from '../../utils/logger.js';
import type {
  ServerBetaBoundaryHealth,
  ServerBetaQueueLaneMetric,
  ServerBetaQueueManager,
} from './types.js';

// ActiveServerBetaQueueManager owns one ServerJobQueue per generation kind.
// It is wired in only when CLAUDE_MEM_QUEUE_ENGINE=bullmq is set; otherwise
// create-server-beta-service.ts keeps the disabled adapter in place.
//
// This boundary intentionally does not start any Worker processors here.
// Phase 4+ wires processors that consume the queues, calling
// `start(kind, processor)` once provider generation is ready. Until then,
// the queues exist as transports for `enqueueOutbox` to publish into.

const QUEUE_KINDS: ServerGenerationJobKind[] = ['event', 'event-batch', 'summary', 'reindex'];
const DEFAULT_QUEUE_CONCURRENCY = 1;
const GLOBAL_CONCURRENCY_ENV = 'CLAUDE_MEM_GENERATION_WORKER_CONCURRENCY';
const QUEUE_CONCURRENCY_ENV: Record<ServerGenerationJobKind, string> = {
  event: 'CLAUDE_MEM_GENERATION_EVENT_CONCURRENCY',
  'event-batch': 'CLAUDE_MEM_GENERATION_EVENT_BATCH_CONCURRENCY',
  summary: 'CLAUDE_MEM_GENERATION_SUMMARY_CONCURRENCY',
  reindex: 'CLAUDE_MEM_GENERATION_REINDEX_CONCURRENCY',
};

function parseQueueConcurrency(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn('QUEUE', 'ignoring invalid server-beta queue concurrency', {
      value,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

export function resolveServerBetaQueueConcurrencies(
  env: NodeJS.ProcessEnv = process.env,
): Record<ServerGenerationJobKind, number> {
  const globalConcurrency = parseQueueConcurrency(
    env[GLOBAL_CONCURRENCY_ENV],
    DEFAULT_QUEUE_CONCURRENCY,
  );
  return {
    event: parseQueueConcurrency(env[QUEUE_CONCURRENCY_ENV.event], globalConcurrency),
    'event-batch': parseQueueConcurrency(env[QUEUE_CONCURRENCY_ENV['event-batch']], globalConcurrency),
    summary: parseQueueConcurrency(env[QUEUE_CONCURRENCY_ENV.summary], globalConcurrency),
    reindex: parseQueueConcurrency(env[QUEUE_CONCURRENCY_ENV.reindex], globalConcurrency),
  };
}

export class ActiveServerBetaQueueManager implements ServerBetaQueueManager {
  readonly kind = 'queue-manager' as const;

  private readonly queues: Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>;
  private readonly concurrencyByKind: Record<ServerGenerationJobKind, number>;
  private closed = false;

  constructor(
    private readonly config: RedisQueueConfig,
    queues?: Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>,
  ) {
    if (config.engine !== 'bullmq') {
      throw new Error(
        `ActiveServerBetaQueueManager requires CLAUDE_MEM_QUEUE_ENGINE=bullmq (got ${config.engine}); ` +
          'do not instantiate when bullmq is not selected.',
      );
    }
    this.concurrencyByKind = resolveServerBetaQueueConcurrencies();
    this.queues = queues ?? this.buildQueues(config);
  }

  getQueue(kind: ServerGenerationJobKind): ServerJobQueue<ServerGenerationJobPayload> {
    const queue = this.queues.get(kind);
    if (!queue) {
      throw new Error(`unknown server generation job kind: ${kind}`);
    }
    return queue;
  }

  start(kind: ServerGenerationJobKind, processor: Processor<ServerGenerationJobPayload>): void {
    this.getQueue(kind).start(processor);
  }

  getHealth(): ServerBetaBoundaryHealth {
    if (this.closed) {
      return { status: 'errored', reason: 'queue-manager closed' };
    }
    const lanes = QUEUE_KINDS.map((kind) => ({
      kind,
      name: SERVER_JOB_QUEUE_NAMES[kind],
      concurrency: this.concurrencyByKind[kind],
    }));
    return {
      status: 'active',
      reason: 'BullMQ-backed queue manager wired',
      details: {
        engine: this.config.engine,
        mode: this.config.mode,
        host: this.config.host,
        port: this.config.port,
        prefix: this.config.prefix,
        lanes,
      },
    };
  }

  /**
   * Phase 12 — per-lane counts. Returns BullMQ getJobCounts plus the
   * per-process stalled counter. If Redis is unreachable, the lane is
   * reported with an `unavailable` flag rather than throwing so /api/health
   * remains responsive even in partial-failure modes.
   */
  async getLaneMetrics(): Promise<ServerBetaQueueLaneMetric[]> {
    const out: ServerBetaQueueLaneMetric[] = [];
    for (const kind of QUEUE_KINDS) {
      const queue = this.queues.get(kind);
      if (!queue) continue;
      const lifecycle = queue.getLifecycleCounters();
      try {
        const counts = await queue.getCounts();
        out.push({
          kind,
          name: SERVER_JOB_QUEUE_NAMES[kind],
          waiting: counts.waiting,
          active: counts.active,
          completed: counts.completed,
          failed: counts.failed,
          delayed: counts.delayed,
          stalled: lifecycle.stalled,
          unavailable: false,
        });
      } catch (error) {
        out.push({
          kind,
          name: SERVER_JOB_QUEUE_NAMES[kind],
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          stalled: lifecycle.stalled,
          unavailable: true,
          unavailableReason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors: Error[] = [];
    for (const queue of this.queues.values()) {
      try {
        await queue.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      logger.warn('QUEUE', 'errors closing server-beta queue manager', {
        count: errors.length,
        first: errors[0]!.message,
      });
      throw errors[0];
    }
  }

  private buildQueues(
    config: RedisQueueConfig,
  ): Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>> {
    const map = new Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>();
    for (const kind of QUEUE_KINDS) {
      map.set(
        kind,
        new ServerJobQueue<ServerGenerationJobPayload>({
          name: SERVER_JOB_QUEUE_NAMES[kind],
          config,
          concurrency: this.concurrencyByKind[kind],
        }),
      );
    }
    return map;
  }
}
