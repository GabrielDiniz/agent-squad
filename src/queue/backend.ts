import type { AgentType } from "../db.js";

export interface EnqueueInput {
  issueKey: string;
  agentType: AgentType;
  triggerStatus: string;
  eventVersion: number;
  idempotencyKey: string;
  payload: unknown;
}

export interface EnqueueResult {
  jobId: number;
  deduped: boolean;
}

export interface QueueJobRecord {
  id: number;
  issueKey: string;
  agentType: AgentType;
  triggerStatus: string | null;
  eventVersion: number;
  state: string;
  attempts: number;
  maxAttempts: number;
}

export interface CheckpointCoreState {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  softBudgetMode: boolean;
  maxTokenRecoveries: number;
  promptMode: "compact" | "balanced" | "deep";
}

export interface CheckpointContextState {
  summary: string;
  snapshotText?: string;
  lastCriticalEvent?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointToolProgress {
  toolName: string;
  status: "completed" | "skipped" | "failed";
  cacheKey?: string;
  resultHash?: string;
  cachedResult?: string;
  validUntil?: string;
  skipReason?: string;
  replaySource?: "live" | "checkpoint_cache";
}

export interface ExecutionCheckpointState {
  core: CheckpointCoreState;
  context: CheckpointContextState;
  toolProgress?: CheckpointToolProgress[];
}

export interface SaveExecutionCheckpointInput {
  jobId: number;
  issueKey: string;
  agentType: AgentType;
  checkpointVersion: number;
  checkpointSeq: number;
  state: ExecutionCheckpointState;
}

export interface ExecutionCheckpointRecord {
  id: number;
  jobId: number;
  issueKey: string;
  agentType: AgentType;
  checkpointVersion: number;
  checkpointSeq: number;
  state: ExecutionCheckpointState;
  isValid: boolean;
  invalidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueBackend {
  enqueueJob(input: EnqueueInput): Promise<EnqueueResult>;
  claimNextJob(workerId: string, leaseMs: number): Promise<QueueJobRecord | null>;
  renewJobLease(jobId: number, workerId: string, leaseMs: number): Promise<boolean>;
  completeJob(jobId: number, workerId: string): Promise<boolean>;
  retryJob(jobId: number, workerId: string, retryDelayMs: number, errorCode: string, errorMessage: string): Promise<boolean>;
  failJob(jobId: number, workerId: string, errorCode: string, errorMessage: string): Promise<boolean>;
  getJobState(jobId: number): Promise<string | null>;
  isJobSuperseded(issueKey: string, eventVersion: number): Promise<boolean>;
  markJobStale(jobId: number, workerId: string, reason: string): Promise<boolean>;
  markJobCancelled(jobId: number, workerId: string, reason: string): Promise<boolean>;
  saveExecutionCheckpoint(input: SaveExecutionCheckpointInput): Promise<number | null>;
  getLatestExecutionCheckpoint(jobId: number): Promise<ExecutionCheckpointRecord | null>;
  invalidateExecutionCheckpoints(jobId: number, reason: string): Promise<number>;
}

export interface LockBackend {
  acquireIssueLock(issueKey: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  renewIssueLock(issueKey: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  releaseIssueLock(issueKey: string, workerId: string, jobId: number): Promise<boolean>;
  acquireCodebaseLock(codebaseName: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  renewCodebaseLock(codebaseName: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  releaseCodebaseLock(codebaseName: string, workerId: string, jobId: number): Promise<boolean>;
}
