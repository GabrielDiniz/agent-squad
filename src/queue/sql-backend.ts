import {
  dbAcquireCodebaseLock,
  dbAcquireIssueLock,
  dbClaimNextJob,
  dbCompleteJob,
  dbEnqueueJob,
  dbFailJob,
  dbGetLatestExecutionCheckpoint,
  dbGetJobState,
  dbInvalidateExecutionCheckpointsByJob,
  dbIsJobSuperseded,
  dbMarkJobCancelled,
  dbMarkJobStale,
  dbReleaseCodebaseLock,
  dbReleaseIssueLock,
  dbRenewCodebaseLock,
  dbRenewIssueLock,
  dbRenewJobLease,
  dbRetryJob,
  dbSaveExecutionCheckpoint,
} from "../db.js";
import type {
  LockBackend,
  QueueBackend,
  EnqueueInput,
  EnqueueResult,
  QueueJobRecord,
  SaveExecutionCheckpointInput,
  ExecutionCheckpointRecord,
} from "./backend.js";

class SqlQueueLockBackend implements QueueBackend, LockBackend {
  async enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
    return dbEnqueueJob(input);
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<QueueJobRecord | null> {
    return dbClaimNextJob(workerId, leaseMs);
  }

  async renewJobLease(jobId: number, workerId: string, leaseMs: number): Promise<boolean> {
    return dbRenewJobLease(jobId, workerId, leaseMs);
  }

  async completeJob(jobId: number, workerId: string): Promise<boolean> {
    return dbCompleteJob(jobId, workerId);
  }

  async retryJob(
    jobId: number,
    workerId: string,
    retryDelayMs: number,
    errorCode: string,
    errorMessage: string
  ): Promise<boolean> {
    return dbRetryJob(jobId, workerId, retryDelayMs, errorCode, errorMessage);
  }

  async failJob(jobId: number, workerId: string, errorCode: string, errorMessage: string): Promise<boolean> {
    return dbFailJob(jobId, workerId, errorCode, errorMessage);
  }

  async getJobState(jobId: number): Promise<string | null> {
    return dbGetJobState(jobId);
  }

  async isJobSuperseded(issueKey: string, eventVersion: number): Promise<boolean> {
    return dbIsJobSuperseded(issueKey, eventVersion);
  }

  async markJobStale(jobId: number, workerId: string, reason: string): Promise<boolean> {
    return dbMarkJobStale(jobId, workerId, reason);
  }

  async markJobCancelled(jobId: number, workerId: string, reason: string): Promise<boolean> {
    return dbMarkJobCancelled(jobId, workerId, reason);
  }

  async saveExecutionCheckpoint(input: SaveExecutionCheckpointInput): Promise<number | null> {
    return dbSaveExecutionCheckpoint(input);
  }

  async getLatestExecutionCheckpoint(jobId: number): Promise<ExecutionCheckpointRecord | null> {
    return dbGetLatestExecutionCheckpoint(jobId);
  }

  async invalidateExecutionCheckpoints(jobId: number, reason: string): Promise<number> {
    return dbInvalidateExecutionCheckpointsByJob(jobId, reason);
  }

  async acquireIssueLock(issueKey: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean> {
    return dbAcquireIssueLock(issueKey, workerId, jobId, leaseMs);
  }

  async renewIssueLock(issueKey: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean> {
    return dbRenewIssueLock(issueKey, workerId, jobId, leaseMs);
  }

  async releaseIssueLock(issueKey: string, workerId: string, jobId: number): Promise<boolean> {
    return dbReleaseIssueLock(issueKey, workerId, jobId);
  }

  async acquireCodebaseLock(codebaseName: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean> {
    return dbAcquireCodebaseLock(codebaseName, workerId, jobId, leaseMs);
  }

  async renewCodebaseLock(codebaseName: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean> {
    return dbRenewCodebaseLock(codebaseName, workerId, jobId, leaseMs);
  }

  async releaseCodebaseLock(codebaseName: string, workerId: string, jobId: number): Promise<boolean> {
    return dbReleaseCodebaseLock(codebaseName, workerId, jobId);
  }
}

let singleton: SqlQueueLockBackend | null = null;

export function getQueueLockBackend(): QueueBackend & LockBackend {
  const backend = (process.env.QUEUE_BACKEND ?? "sql").toLowerCase();
  if (backend === "redis") {
    throw new Error("QUEUE_BACKEND=redis ainda nao implementado. Use sql.");
  }
  if (backend !== "sql") {
    throw new Error(`QUEUE_BACKEND invalido: ${backend}. Use sql ou redis.`);
  }

  if (!singleton) {
    singleton = new SqlQueueLockBackend();
  }
  return singleton;
}
