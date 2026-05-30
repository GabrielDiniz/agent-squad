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
}

export interface LockBackend {
  acquireIssueLock(issueKey: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  renewIssueLock(issueKey: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  releaseIssueLock(issueKey: string, workerId: string, jobId: number): Promise<boolean>;
  acquireCodebaseLock(codebaseName: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  renewCodebaseLock(codebaseName: string, workerId: string, jobId: number, leaseMs: number): Promise<boolean>;
  releaseCodebaseLock(codebaseName: string, workerId: string, jobId: number): Promise<boolean>;
}
