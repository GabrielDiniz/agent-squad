import os from "node:os";
import {
  type QueueJobRecord,
  type QueueBackend,
  type LockBackend,
  type ExecutionCheckpointState,
} from "./queue/backend.js";
import { isCheckpointVersionCompatible } from "./checkpoint-governance.js";
import { reviewIssue } from "./agents/reviewer.js";
import { analyzeIssue } from "./agents/analyst.js";
import { implementIssue } from "./agents/implementor.js";
import { resolveCodebases } from "./codebases.js";
import { getQueueLockBackend } from "./queue/sql-backend.js";

type ErrorClass = "transient" | "permanent";

export interface WorkerConfig {
  workerId: string;
  pollMs: number;
  concurrency: number;
  leaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getRehydrateTimeoutMs(agentType: QueueJobRecord["agentType"]): number {
  const perAgent =
    agentType === "reviewer"
      ? process.env.REVIEWER_REHYDRATE_TIMEOUT_MS
      : agentType === "analyst"
        ? process.env.ANALYST_REHYDRATE_TIMEOUT_MS
        : process.env.IMPLEMENTOR_REHYDRATE_TIMEOUT_MS;
  return parsePositiveInt(perAgent ?? process.env.RESUME_REHYDRATE_TIMEOUT_MS, 3000);
}

export function classifyJobError(err: unknown): ErrorClass {
  const message = String((err as any)?.message ?? err ?? "").toLowerCase();
  const transientHints = [
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "etimedout",
    "429",
    "rate limit",
    "too many requests",
    "tempor",
    "network",
    "unavailable",
    "503",
    "502",
    "504",
    "deadlock",
    "lock wait timeout",
  ];
  return transientHints.some((h) => message.includes(h)) ? "transient" : "permanent";
}

export function computeRetryDelayMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
  randomFn: () => number = Math.random
): number {
  const safeAttempts = Math.max(1, attempts);
  const exp = Math.min(maxMs, baseMs * Math.pow(2, safeAttempts - 1));
  const jitter = 0.8 + randomFn() * 0.4;
  return Math.min(maxMs, Math.floor(exp * jitter));
}

async function runAgentForJob(
  job: QueueJobRecord,
  checkpoint?: () => Promise<void>,
  saveExecutionCheckpoint?: (checkpointSeq: number, state: ExecutionCheckpointState) => Promise<void>,
  resumeCheckpointState?: ExecutionCheckpointState | null
): Promise<void> {
  if (job.agentType === "reviewer") {
    await reviewIssue(job.issueKey, { checkpoint, saveExecutionCheckpoint, resumeCheckpointState });
    return;
  }
  if (job.agentType === "analyst") {
    await analyzeIssue(job.issueKey, { checkpoint, saveExecutionCheckpoint, resumeCheckpointState });
    return;
  }
  if (job.agentType === "implementor") {
    await implementIssue(job.issueKey, { checkpoint, saveExecutionCheckpoint, resumeCheckpointState });
    return;
  }
  throw new Error(`agent_type invalido para job ${job.id}: ${job.agentType}`);
}

function isFunctionalResumeEnabledForAgent(agentType: QueueJobRecord["agentType"]): boolean {
  const functionalResumeEnabled = (process.env.RESUME_ENABLE_FUNCTIONAL ?? "0") !== "0";
  if (!functionalResumeEnabled) return false;
  if (agentType === "reviewer") return (process.env.REVIEWER_ENABLE_RESUME ?? "0") !== "0";
  if (agentType === "analyst") return (process.env.ANALYST_ENABLE_RESUME ?? "0") !== "0";
  if (agentType === "implementor") return (process.env.IMPLEMENTOR_ENABLE_RESUME ?? "0") !== "0";
  return false;
}

function resolveCodebaseLockKey(job: QueueJobRecord): string | null {
  if (job.agentType !== "implementor") return null;
  const codebases = resolveCodebases();
  if (codebases.length === 1) {
    return codebases[0]?.name ?? "global-write";
  }
  return "global-write";
}

type CheckpointAction = "continue" | "stale" | "cancelled";

async function checkJobCheckpoint(
  job: QueueJobRecord,
  workerId: string,
  stage: string,
  queue: QueueBackend
): Promise<CheckpointAction> {
  const currentState = await queue.getJobState(job.id);
  if (currentState === "cancelled") {
    await queue.markJobCancelled(job.id, workerId, `Cancelled cooperatively at ${stage}`);
    try {
      await queue.invalidateExecutionCheckpoints(job.id, `checkpoint_invalidated_by_cancelled:${stage}`);
    } catch (err) {
      console.warn(`[worker] job=${job.id} falha ao invalidar checkpoints após cancelamento:`, err);
    }
    console.warn(`[worker] job=${job.id} cancelled at checkpoint=${stage}`);
    return "cancelled";
  }

  const superseded = await queue.isJobSuperseded(job.issueKey, job.eventVersion);
  if (superseded) {
    await queue.markJobStale(job.id, workerId, `Superseded by newer event at ${stage}`);
    try {
      await queue.invalidateExecutionCheckpoints(job.id, `checkpoint_invalidated_by_superseded:${stage}`);
    } catch (err) {
      console.warn(`[worker] job=${job.id} falha ao invalidar checkpoints após supersedência:`, err);
    }
    console.warn(`[worker] job=${job.id} stale at checkpoint=${stage}`);
    return "stale";
  }

  return "continue";
}

async function runCheckpointOrThrow(
  job: QueueJobRecord,
  workerId: string,
  stage: string,
  queue: QueueBackend
): Promise<void> {
  const action = await checkJobCheckpoint(job, workerId, stage, queue);
  if (action === "continue") return;
  throw new Error(action === "cancelled" ? "job_cancelled" : "job_stale");
}

export async function processClaimedJob(
  job: QueueJobRecord,
  config: WorkerConfig,
  queue: QueueBackend,
  locks: LockBackend,
  randomFn: () => number = Math.random
): Promise<void> {
  const codebaseLockKey = resolveCodebaseLockKey(job);
  const issueLockAcquired = await locks.acquireIssueLock(job.issueKey, config.workerId, job.id, config.leaseMs);
  if (!issueLockAcquired) {
    const retryDelayMs = computeRetryDelayMs(job.attempts, config.retryBaseMs, config.retryMaxMs, randomFn);
    await queue.retryJob(job.id, config.workerId, retryDelayMs, "issue_lock_unavailable", "issue lock indisponivel");
    console.warn(`[worker] job=${job.id} issue lock busy, retry in ${retryDelayMs}ms`);
    return;
  }

  if (codebaseLockKey) {
    const codebaseLockAcquired = await locks.acquireCodebaseLock(codebaseLockKey, config.workerId, job.id, config.leaseMs);
    if (!codebaseLockAcquired) {
      const retryDelayMs = computeRetryDelayMs(job.attempts, config.retryBaseMs, config.retryMaxMs, randomFn);
      await locks.releaseIssueLock(job.issueKey, config.workerId, job.id);
      await queue.retryJob(job.id, config.workerId, retryDelayMs, "codebase_lock_unavailable", "codebase lock indisponivel");
      console.warn(`[worker] job=${job.id} codebase lock busy (${codebaseLockKey}), retry in ${retryDelayMs}ms`);
      return;
    }
  }

  const heartbeatEveryMs = Math.max(1_000, Math.floor(config.leaseMs / 2));
  const heartbeat = setInterval(() => {
    void queue.renewJobLease(job.id, config.workerId, config.leaseMs).catch((err) => {
      console.warn(`[worker] falha ao renovar lease do job ${job.id}:`, err);
    });
    void locks.renewIssueLock(job.issueKey, config.workerId, job.id, config.leaseMs).catch((err) => {
      console.warn(`[worker] falha ao renovar issue lock do job ${job.id}:`, err);
    });
    if (codebaseLockKey) {
      void locks.renewCodebaseLock(codebaseLockKey, config.workerId, job.id, config.leaseMs).catch((err) => {
        console.warn(`[worker] falha ao renovar codebase lock do job ${job.id}:`, err);
      });
    }
  }, heartbeatEveryMs);

  try {
    const checkpointLoadEnabled = (process.env.RESUME_ENABLE_CHECKPOINT_LOAD ?? "1") !== "0";
    let latestCheckpointState: ExecutionCheckpointState | null = null;
    let checkpointLoadAttempted = false;
    let checkpointLoadHit = false;
    let checkpointLoadFailed = false;
    let checkpointLoadMs = 0;
    let checkpointVersionMismatch = false;
    let checkpointSaveAttempts = 0;
    let checkpointSaveSuccess = 0;
    let checkpointSaveFailed = 0;
    let checkpointSaveCompensated = false;

    if (checkpointLoadEnabled) {
      checkpointLoadAttempted = true;
      const loadStartedAt = Date.now();
      const rehydrateTimeoutMs = getRehydrateTimeoutMs(job.agentType);
      try {
        const latestCheckpoint = await Promise.race([
          queue.getLatestExecutionCheckpoint(job.id),
          new Promise<null>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`rehydrate_timeout_ms_${rehydrateTimeoutMs}`)), rehydrateTimeoutMs);
          }),
        ]);
        checkpointLoadMs = Date.now() - loadStartedAt;
        if (latestCheckpoint) {
          if (isCheckpointVersionCompatible(latestCheckpoint.checkpointVersion)) {
            latestCheckpointState = latestCheckpoint.state;
            checkpointLoadHit = true;
            console.log(
              `[worker] job=${job.id} checkpoint encontrado seq=${latestCheckpoint.checkpointSeq} version=${latestCheckpoint.checkpointVersion} loadMs=${checkpointLoadMs}`
            );
          } else {
            checkpointVersionMismatch = true;
            try {
              await queue.invalidateExecutionCheckpoints(
                job.id,
                `checkpoint_version_incompatible:${latestCheckpoint.checkpointVersion}`
              );
            } catch (err) {
              console.warn(`[worker] job=${job.id} falha ao invalidar checkpoint incompatível:`, err);
            }
            console.warn(
              `[worker] job=${job.id} checkpoint incompatível version=${latestCheckpoint.checkpointVersion} (fallback cold start)`
            );
          }
        } else {
          console.log(`[worker] job=${job.id} sem checkpoint valido (cold start) loadMs=${checkpointLoadMs}`);
        }
      } catch (err) {
        checkpointLoadMs = Date.now() - loadStartedAt;
        checkpointLoadFailed = true;
        console.warn(`[worker] job=${job.id} falha ao carregar checkpoint (fallback cold start) loadMs=${checkpointLoadMs}:`, err);
      }
    }

    await runCheckpointOrThrow(job, config.workerId, "before-run", queue);

    console.log(
      `[worker] processing job=${job.id} issue=${job.issueKey} agent=${job.agentType} attempt=${job.attempts}/${job.maxAttempts}`
    );

    const checkpointSaveEnabled = (process.env.RESUME_ENABLE_CHECKPOINT_SAVE ?? "1") !== "0";
    const checkpointVersionRaw = Number(process.env.RESUME_CHECKPOINT_VERSION ?? 1);
    const checkpointVersion = Number.isFinite(checkpointVersionRaw)
      ? Math.max(1, Math.floor(checkpointVersionRaw))
      : 1;

    const saveExecutionCheckpoint = checkpointSaveEnabled
      ? async (checkpointSeq: number, state: ExecutionCheckpointState): Promise<void> => {
          checkpointSaveAttempts++;
          try {
            await queue.saveExecutionCheckpoint({
              jobId: job.id,
              issueKey: job.issueKey,
              agentType: job.agentType,
              checkpointVersion,
              checkpointSeq,
              state,
            });
            checkpointSaveSuccess++;
          } catch (err) {
            checkpointSaveFailed++;
            console.warn(`[worker] job=${job.id} falha ao salvar checkpoint seq=${checkpointSeq}:`, err);
            if (!checkpointSaveCompensated) {
              try {
                await queue.invalidateExecutionCheckpoints(
                  job.id,
                  `checkpoint_save_failed_mid_run:seq=${checkpointSeq}`
                );
                checkpointSaveCompensated = true;
                console.warn(
                  `[worker] job=${job.id} checkpoints invalidados por compensação após falha de save seq=${checkpointSeq}`
                );
              } catch (invalidateErr) {
                console.warn(
                  `[worker] job=${job.id} falha na compensação após erro de save checkpoint seq=${checkpointSeq}:`,
                  invalidateErr
                );
              }
            }
          }
        }
      : undefined;

    const resumeFeatureEnabledForJob = isFunctionalResumeEnabledForAgent(job.agentType);
    const resumeCheckpointState = resumeFeatureEnabledForJob
      ? latestCheckpointState
      : null;

    const resumeAttempts = resumeFeatureEnabledForJob ? 1 : 0;
    const resumeSuccess = resumeCheckpointState ? 1 : 0;
    const resumeFallback = resumeFeatureEnabledForJob && !resumeCheckpointState ? 1 : 0;
    const turnsSkipped = resumeCheckpointState?.core.turns ?? 0;
    const toolsSkipped =
      resumeCheckpointState?.toolProgress?.filter((entry) => entry.status === "skipped").length ?? 0;
    const resumeTokensSavedEstimate = resumeCheckpointState
      ? resumeCheckpointState.core.inputTokens +
        resumeCheckpointState.core.outputTokens +
        resumeCheckpointState.core.cacheReadTokens +
        resumeCheckpointState.core.cacheCreationTokens
      : 0;

    await runAgentForJob(job, async () => {
      await runCheckpointOrThrow(job, config.workerId, "between-turns", queue);
    }, saveExecutionCheckpoint, resumeCheckpointState);

    console.log(
      `[worker] checkpoint-metrics job=${job.id} load_attempted=${checkpointLoadAttempted}` +
        ` load_hit=${checkpointLoadHit} load_failed=${checkpointLoadFailed} load_ms=${checkpointLoadMs}` +
        ` version_mismatch=${checkpointVersionMismatch}` +
        ` save_attempts=${checkpointSaveAttempts} save_success=${checkpointSaveSuccess} save_failed=${checkpointSaveFailed}` +
        ` save_compensated=${checkpointSaveCompensated}` +
        ` resume_attempts=${resumeAttempts} resume_success=${resumeSuccess} resume_fallback=${resumeFallback}` +
        ` turns_skipped=${turnsSkipped} tools_skipped=${toolsSkipped}` +
        ` resume_tokens_saved_estimate=${resumeTokensSavedEstimate}`
    );

    await runCheckpointOrThrow(job, config.workerId, "after-run", queue);

    const completed = await queue.completeJob(job.id, config.workerId);
    if (completed) {
      console.log(`[worker] job=${job.id} done`);
      return;
    }

    const finalState = await queue.getJobState(job.id);
    if (finalState === "stale" || finalState === "cancelled") {
      console.warn(`[worker] job=${job.id} skipped completion due to final_state=${finalState}`);
      return;
    }

    throw new Error(`nao foi possivel concluir job ${job.id}`);
  } catch (err) {
    const errorClass = classifyJobError(err);
    const message = String((err as any)?.message ?? err ?? "erro desconhecido");

    if (message === "job_stale" || message === "job_cancelled") {
      return;
    }

    if (errorClass === "transient" && job.attempts < job.maxAttempts) {
      const retryDelayMs = computeRetryDelayMs(job.attempts, config.retryBaseMs, config.retryMaxMs, randomFn);
      await queue.retryJob(job.id, config.workerId, retryDelayMs, "transient_error", message);
      console.warn(
        `[worker] job=${job.id} transient_error, retry in ${retryDelayMs}ms (attempt ${job.attempts}/${job.maxAttempts})`
      );
    } else {
      const code = errorClass === "transient" ? "retries_exhausted" : "permanent_error";
      await queue.failJob(job.id, config.workerId, code, message);
      console.error(
        `[worker] job=${job.id} failed (${code}) after attempt ${job.attempts}/${job.maxAttempts}: ${message}`
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (codebaseLockKey) {
      await locks.releaseCodebaseLock(codebaseLockKey, config.workerId, job.id).catch((err) => {
        console.warn(`[worker] falha ao liberar codebase lock do job ${job.id}:`, err);
      });
    }
    await locks.releaseIssueLock(job.issueKey, config.workerId, job.id).catch((err) => {
      console.warn(`[worker] falha ao liberar issue lock do job ${job.id}:`, err);
    });
  }
}

export class WorkerRuntime {
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopped = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly queue: QueueBackend,
    private readonly locks: LockBackend
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
    void this.tick();
    console.log(
      `[worker] started id=${this.config.workerId} pollMs=${this.config.pollMs} concurrency=${this.config.concurrency} leaseMs=${this.config.leaseMs}`
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`[worker] stopping id=${this.config.workerId}`);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    while (!this.stopped && this.active < this.config.concurrency) {
      let job: QueueJobRecord | null = null;
      try {
        job = await this.queue.claimNextJob(this.config.workerId, this.config.leaseMs);
      } catch (err) {
        console.error("[worker] erro ao claim job:", err);
        return;
      }

      if (!job) return;

      this.active++;
      void processClaimedJob(job, this.config, this.queue, this.locks)
        .catch((err) => {
          console.error(`[worker] erro inesperado no processamento do job ${job?.id}:`, err);
        })
        .finally(() => {
          this.active--;
          if (!this.stopped) {
            void this.tick();
          }
        });
    }
  }
}

export function buildWorkerConfigFromEnv(): WorkerConfig {
  const hostname = os.hostname().replace(/[^a-zA-Z0-9_.-]/g, "-");
  const workerId = process.env.WORKER_ID?.trim() || `${hostname}-${process.pid}`;

  return {
    workerId,
    pollMs: parsePositiveInt(process.env.WORKER_POLL_MS, 1_000),
    concurrency: parsePositiveInt(process.env.WORKER_CONCURRENCY, 1),
    leaseMs: parsePositiveInt(process.env.WORKER_LEASE_MS, 30_000),
    retryBaseMs: parsePositiveInt(process.env.WORKER_RETRY_BASE_MS, 2_000),
    retryMaxMs: parsePositiveInt(process.env.WORKER_RETRY_MAX_MS, 300_000),
  };
}

export function startWorkerFromEnv(): WorkerRuntime | null {
  const enabled = (process.env.WORKER_ENABLED ?? "1") !== "0";
  if (!enabled) {
    console.log("[worker] disabled by WORKER_ENABLED=0");
    return null;
  }

  const backend = getQueueLockBackend();
  const runtime = new WorkerRuntime(buildWorkerConfigFromEnv(), backend, backend);
  runtime.start();
  return runtime;
}
