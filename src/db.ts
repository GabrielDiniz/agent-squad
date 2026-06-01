import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { getCheckpointMaxPerJob, governCheckpointState, shouldRejectOutOfOrderCheckpoint } from "./checkpoint-governance.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type AgentType = "reviewer" | "analyst" | "implementor";

export interface EnqueueJobInput {
  issueKey: string;
  agentType: AgentType;
  triggerStatus: string;
  eventVersion: number;
  idempotencyKey: string;
  payload: unknown;
}

export interface EnqueueJobResult {
  jobId: number;
  deduped: boolean;
}

export interface QueueJob {
  id: number;
  issueKey: string;
  agentType: AgentType;
  triggerStatus: string | null;
  eventVersion: number;
  state: string;
  attempts: number;
  maxAttempts: number;
}

export interface ExecutionCheckpointState {
  core: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    softBudgetMode: boolean;
    maxTokenRecoveries: number;
    promptMode: "compact" | "balanced" | "deep";
  };
  context: {
    summary: string;
    snapshotText?: string;
    lastCriticalEvent?: string;
    metadata?: Record<string, unknown>;
  };
  toolProgress?: Array<{
    toolName: string;
    status: "completed" | "skipped" | "failed";
    cacheKey?: string;
    resultHash?: string;
    cachedResult?: string;
    validUntil?: string;
    skipReason?: string;
    replaySource?: "live" | "checkpoint_cache";
  }>;
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

export interface IssueWorkStateSnapshot {
  issueKey: string;
  latestEventVersion: number;
  latestJobId: number | null;
  currentState: string;
}

type LockKind = "issue" | "codebase";

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool | null {
  if (!pool && process.env.MYSQL_HOST) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT ?? 3306),
      database: process.env.MYSQL_DATABASE,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: "Z",
      charset: "utf8mb4",
    });
  }
  return pool;
}

// ─── Migration ────────────────────────────────────────────────────────────────

/**
 * Garante que as colunas novas existam em instalações existentes.
 * Seguro rodar múltiplas vezes — usa IF NOT EXISTS.
 */
export async function dbMigrate(): Promise<void> {
  const p = getPool();
  if (!p) return;
  // MySQL 8.0 não suporta ADD COLUMN IF NOT EXISTS (sintaxe MariaDB).
  // Usamos ADD COLUMN simples e ignoramos errno 1060 (Duplicate column name).
  const alterations = [
    "ADD COLUMN agent_type  VARCHAR(20)   DEFAULT NULL AFTER prompt",
    "ADD COLUMN issue_key   VARCHAR(50)   DEFAULT NULL AFTER agent_type",
    "ADD COLUMN model       VARCHAR(100)  DEFAULT NULL AFTER issue_key",
    "ADD COLUMN codebase    VARCHAR(500)  DEFAULT NULL AFTER model",
  ];
  for (const col of alterations) {
    try {
      await p.execute(`ALTER TABLE api_sessions ${col}`);
    } catch (err: any) {
      // 1060 = Duplicate column name (coluna já existe) — ignorar
      if (err?.errno !== 1060) {
        console.error("[db] migration warning:", err);
      }
    }
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS queue_jobs (
      id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      issue_key                 VARCHAR(50)           NOT NULL,
      agent_type                VARCHAR(20)           NOT NULL,
      trigger_status            VARCHAR(100)          DEFAULT NULL,
      event_version             BIGINT UNSIGNED       NOT NULL DEFAULT 0,
      idempotency_key           VARCHAR(191)          NOT NULL,
      payload_json              JSON                  DEFAULT NULL,
      state                     VARCHAR(20)           NOT NULL DEFAULT 'queued',
      priority                  INT                   NOT NULL DEFAULT 100,
      attempts                  INT UNSIGNED          NOT NULL DEFAULT 0,
      max_attempts              INT UNSIGNED          NOT NULL DEFAULT 5,
      next_run_at               DATETIME(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      worker_id                 VARCHAR(100)          DEFAULT NULL,
      claimed_at                DATETIME(3)           DEFAULT NULL,
      lease_until               DATETIME(3)           DEFAULT NULL,
      started_at                DATETIME(3)           DEFAULT NULL,
      finished_at               DATETIME(3)           DEFAULT NULL,
      error_code                VARCHAR(100)          DEFAULT NULL,
      error_message             TEXT                  DEFAULT NULL,
      created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_queue_jobs_idempotency (idempotency_key),
      INDEX idx_queue_jobs_state_next (state, next_run_at, priority, id),
      INDEX idx_queue_jobs_issue (issue_key, state, event_version),
      INDEX idx_queue_jobs_worker (worker_id, lease_until)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS issue_work_state (
      issue_key                 VARCHAR(50)           PRIMARY KEY,
      latest_event_version      BIGINT UNSIGNED       NOT NULL DEFAULT 0,
      latest_job_id             BIGINT UNSIGNED       DEFAULT NULL,
      current_state             VARCHAR(20)           NOT NULL DEFAULT 'idle',
      current_agent_type        VARCHAR(20)           DEFAULT NULL,
      updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_issue_work_state_job (latest_job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS codebase_locks (
      codebase_name             VARCHAR(191)          PRIMARY KEY,
      owner_worker_id           VARCHAR(100)          NOT NULL,
      owner_job_id              BIGINT UNSIGNED       NOT NULL,
      lease_until               DATETIME(3)           NOT NULL,
      heartbeat_at              DATETIME(3)           NOT NULL,
      created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_codebase_locks_lease (lease_until),
      INDEX idx_codebase_locks_owner (owner_worker_id, owner_job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS issue_locks (
      issue_key                 VARCHAR(50)           PRIMARY KEY,
      owner_worker_id           VARCHAR(100)          NOT NULL,
      owner_job_id              BIGINT UNSIGNED       NOT NULL,
      lease_until               DATETIME(3)           NOT NULL,
      heartbeat_at              DATETIME(3)           NOT NULL,
      created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_issue_locks_lease (lease_until),
      INDEX idx_issue_locks_owner (owner_worker_id, owner_job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS agent_execution_checkpoints (
      id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      job_id                    BIGINT UNSIGNED       NOT NULL,
      issue_key                 VARCHAR(50)           NOT NULL,
      agent_type                VARCHAR(20)           NOT NULL,
      checkpoint_version        INT UNSIGNED          NOT NULL DEFAULT 1,
      checkpoint_seq            INT UNSIGNED          NOT NULL,
      state_json                JSON                  NOT NULL,
      is_valid                  TINYINT(1)            NOT NULL DEFAULT 1,
      invalid_reason            VARCHAR(255)          DEFAULT NULL,
      created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_agent_checkpoint_job_seq (job_id, checkpoint_seq),
      INDEX idx_agent_checkpoint_job_seq (job_id, checkpoint_seq),
      INDEX idx_agent_checkpoint_issue_agent (issue_key, agent_type, created_at),
      INDEX idx_agent_checkpoint_valid (is_valid, job_id, checkpoint_seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE OR REPLACE VIEW queue_jobs_overview AS
      SELECT
        state,
        COUNT(*) AS total,
        MIN(next_run_at) AS next_eligible_at,
        MAX(updated_at) AS last_update_at
      FROM queue_jobs
      GROUP BY state`,
    `CREATE OR REPLACE VIEW queue_jobs_backlog_by_issue AS
      SELECT
        issue_key,
        state,
        COUNT(*) AS total,
        MAX(event_version) AS max_event_version,
        MAX(updated_at) AS last_update_at
      FROM queue_jobs
      GROUP BY issue_key, state
      ORDER BY last_update_at DESC`,
  ];

  for (const sql of statements) {
    try {
      await p.execute(sql);
    } catch (err) {
      console.error("[db] migration warning:", err);
    }
  }
}

export async function dbPing(): Promise<boolean> {
  const p = getPool();
  if (!p) return true;
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function dbEnqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para enqueue de jobs");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `INSERT INTO queue_jobs
      (issue_key, agent_type, trigger_status, event_version, idempotency_key, payload_json, state, next_run_at)
     VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 'queued', CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [
      input.issueKey,
      input.agentType,
      input.triggerStatus,
      input.eventVersion,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
    ]
  );

  const jobId = Number(result.insertId);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error("Nao foi possivel identificar job enfileirado");
  }

  const deduped = result.affectedRows > 1;

  await p.execute(
    `INSERT INTO issue_work_state
      (issue_key, latest_event_version, latest_job_id, current_state, current_agent_type)
     VALUES (?, ?, ?, 'queued', ?)
     ON DUPLICATE KEY UPDATE
       latest_event_version = GREATEST(latest_event_version, VALUES(latest_event_version)),
       latest_job_id = IF(VALUES(latest_event_version) >= latest_event_version, VALUES(latest_job_id), latest_job_id),
       current_state = IF(VALUES(latest_event_version) >= latest_event_version, 'queued', current_state),
       current_agent_type = IF(VALUES(latest_event_version) >= latest_event_version, VALUES(current_agent_type), current_agent_type)`,
    [input.issueKey, input.eventVersion, jobId, input.agentType]
  );

  if (!deduped) {
    await p.execute(
      `UPDATE queue_jobs
          SET state = 'stale',
              finished_at = CURRENT_TIMESTAMP(3),
              error_code = 'superseded',
              error_message = ?
        WHERE issue_key = ?
          AND id <> ?
          AND state = 'queued'
          AND event_version < ?`,
      [
        `Superseded by newer event_version=${input.eventVersion} job_id=${jobId}`,
        input.issueKey,
        jobId,
        input.eventVersion,
      ]
    );
  }

  return { jobId, deduped };
}

export async function dbGetIssueWorkState(issueKey: string): Promise<IssueWorkStateSnapshot | null> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [rows] = await p.query<mysql.RowDataPacket[]>(
    `SELECT issue_key, latest_event_version, latest_job_id, current_state
       FROM issue_work_state
      WHERE issue_key = ?
      LIMIT 1`,
    [issueKey]
  );

  const row = rows[0];
  if (!row) return null;

  return {
    issueKey: String(row.issue_key),
    latestEventVersion: Number(row.latest_event_version ?? 0),
    latestJobId: row.latest_job_id == null ? null : Number(row.latest_job_id),
    currentState: String(row.current_state ?? "unknown"),
  };
}

export async function dbGetJobState(jobId: number): Promise<string | null> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [rows] = await p.query<mysql.RowDataPacket[]>(
    `SELECT state
       FROM queue_jobs
      WHERE id = ?
      LIMIT 1`,
    [jobId]
  );
  const row = rows[0];
  return row ? String(row.state ?? "") : null;
}

export async function dbIsJobSuperseded(issueKey: string, eventVersion: number): Promise<boolean> {
  const snapshot = await dbGetIssueWorkState(issueKey);
  if (!snapshot) return false;
  return snapshot.latestEventVersion > eventVersion;
}

export async function dbMarkJobStale(
  jobId: number,
  workerId: string,
  reason: string
): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE queue_jobs
        SET state = 'stale',
            finished_at = CURRENT_TIMESTAMP(3),
            lease_until = NULL,
            worker_id = NULL,
            error_code = 'superseded',
            error_message = ?
      WHERE id = ?
        AND state = 'running'
        AND worker_id = ?`,
    [reason.slice(0, 4000), jobId, workerId]
  );

  if (result.affectedRows > 0) {
    await p.execute(
      `UPDATE issue_work_state
          SET current_state = 'stale',
              latest_job_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE latest_job_id = ?`,
      [jobId, jobId]
    );
  }

  return result.affectedRows > 0;
}

export async function dbMarkJobCancelled(
  jobId: number,
  workerId: string,
  reason: string
): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE queue_jobs
        SET state = 'cancelled',
            finished_at = CURRENT_TIMESTAMP(3),
            lease_until = NULL,
            worker_id = NULL,
            error_code = 'cancelled',
            error_message = ?
      WHERE id = ?
        AND state = 'running'
        AND worker_id = ?`,
    [reason.slice(0, 4000), jobId, workerId]
  );

  if (result.affectedRows > 0) {
    await p.execute(
      `UPDATE issue_work_state
          SET current_state = 'cancelled',
              latest_job_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE latest_job_id = ?`,
      [jobId, jobId]
    );
  }

  return result.affectedRows > 0;
}

function mapQueueJobRow(row: any): QueueJob {
  return {
    id: Number(row.id),
    issueKey: String(row.issue_key),
    agentType: row.agent_type as AgentType,
    triggerStatus: row.trigger_status ?? null,
    eventVersion: Number(row.event_version ?? 0),
    state: String(row.state),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
  };
}

export async function dbClaimNextJob(workerId: string, leaseMs: number): Promise<QueueJob | null> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id, issue_key, agent_type, trigger_status, event_version, state, attempts, max_attempts
         FROM queue_jobs
        WHERE state = 'queued'
          AND next_run_at <= CURRENT_TIMESTAMP(3)
        ORDER BY priority ASC, next_run_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );

    const row = rows[0];
    if (!row) {
      await conn.rollback();
      return null;
    }

    const jobId = Number(row.id);
    await conn.execute(
      `UPDATE queue_jobs
          SET state = 'running',
              worker_id = ?,
              claimed_at = CURRENT_TIMESTAMP(3),
              lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND),
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
              attempts = attempts + 1
        WHERE id = ?`,
      [workerId, Math.max(1, Math.floor(leaseMs * 1000)), jobId]
    );

    const [claimedRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id, issue_key, agent_type, trigger_status, event_version, state, attempts, max_attempts
         FROM queue_jobs
        WHERE id = ?
        LIMIT 1`,
      [jobId]
    );

    await conn.commit();
    const claimed = claimedRows[0];
    return claimed ? mapQueueJobRow(claimed) : null;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // ignora rollback secundário
    }
    throw err;
  } finally {
    conn.release();
  }
}

export async function dbRenewJobLease(jobId: number, workerId: string, leaseMs: number): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE queue_jobs
        SET lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND state = 'running'
        AND worker_id = ?`,
    [Math.max(1, Math.floor(leaseMs * 1000)), jobId, workerId]
  );
  return result.affectedRows > 0;
}

export async function dbCompleteJob(jobId: number, workerId: string): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE queue_jobs
        SET state = 'done',
            finished_at = CURRENT_TIMESTAMP(3),
            lease_until = NULL,
            worker_id = NULL,
            error_code = NULL,
            error_message = NULL
      WHERE id = ?
        AND state = 'running'
        AND worker_id = ?`,
    [jobId, workerId]
  );

  if (result.affectedRows > 0) {
    await p.execute(
      `UPDATE issue_work_state
          SET current_state = 'done',
              latest_job_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE latest_job_id = ?`,
      [jobId, jobId]
    );
  }

  return result.affectedRows > 0;
}

export async function dbRetryJob(
  jobId: number,
  workerId: string,
  retryDelayMs: number,
  errorCode: string,
  errorMessage: string
): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE queue_jobs
        SET state = 'queued',
            next_run_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND),
            worker_id = NULL,
            claimed_at = NULL,
            lease_until = NULL,
            error_code = ?,
            error_message = ?
      WHERE id = ?
        AND state = 'running'
        AND worker_id = ?`,
    [Math.max(1, Math.floor(retryDelayMs * 1000)), errorCode, errorMessage.slice(0, 4000), jobId, workerId]
  );

  if (result.affectedRows > 0) {
    await p.execute(
      `UPDATE issue_work_state
          SET current_state = 'queued',
              latest_job_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE latest_job_id = ?`,
      [jobId, jobId]
    );
  }

  return result.affectedRows > 0;
}

export async function dbFailJob(
  jobId: number,
  workerId: string,
  errorCode: string,
  errorMessage: string
): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para worker");
  }

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE queue_jobs
        SET state = 'failed',
            finished_at = CURRENT_TIMESTAMP(3),
            worker_id = NULL,
            lease_until = NULL,
            error_code = ?,
            error_message = ?
      WHERE id = ?
        AND state = 'running'
        AND worker_id = ?`,
    [errorCode, errorMessage.slice(0, 4000), jobId, workerId]
  );

  if (result.affectedRows > 0) {
    await p.execute(
      `UPDATE issue_work_state
          SET current_state = 'failed',
              latest_job_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE latest_job_id = ?`,
      [jobId, jobId]
    );
  }

  return result.affectedRows > 0;
}

async function dbAcquireLock(
  kind: LockKind,
  key: string,
  workerId: string,
  jobId: number,
  leaseMs: number
): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para locks");
  }

  const table = kind === "issue" ? "issue_locks" : "codebase_locks";
  const keyColumn = kind === "issue" ? "issue_key" : "codebase_name";
  const leaseUs = Math.max(1, Math.floor(leaseMs * 1000));

  await p.execute(
    `INSERT INTO ${table}
      (${keyColumn}, owner_worker_id, owner_job_id, lease_until, heartbeat_at)
     VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND), CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
      owner_worker_id = IF(lease_until < CURRENT_TIMESTAMP(3), VALUES(owner_worker_id), owner_worker_id),
      owner_job_id = IF(lease_until < CURRENT_TIMESTAMP(3), VALUES(owner_job_id), owner_job_id),
      lease_until = IF(lease_until < CURRENT_TIMESTAMP(3), VALUES(lease_until), lease_until),
      heartbeat_at = IF(lease_until < CURRENT_TIMESTAMP(3), VALUES(heartbeat_at), heartbeat_at)`,
    [key, workerId, jobId, leaseUs]
  );

  const [rows] = await p.query<mysql.RowDataPacket[]>(
    `SELECT owner_worker_id, owner_job_id, lease_until
       FROM ${table}
      WHERE ${keyColumn} = ?
      LIMIT 1`,
    [key]
  );
  const row = rows[0];
  return Boolean(row && row.owner_worker_id === workerId && Number(row.owner_job_id) === jobId);
}

async function dbRenewLock(
  kind: LockKind,
  key: string,
  workerId: string,
  jobId: number,
  leaseMs: number
): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para locks");
  }

  const table = kind === "issue" ? "issue_locks" : "codebase_locks";
  const keyColumn = kind === "issue" ? "issue_key" : "codebase_name";
  const leaseUs = Math.max(1, Math.floor(leaseMs * 1000));

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE ${table}
        SET lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND),
            heartbeat_at = CURRENT_TIMESTAMP(3)
      WHERE ${keyColumn} = ?
        AND owner_worker_id = ?
        AND owner_job_id = ?`,
    [leaseUs, key, workerId, jobId]
  );

  return result.affectedRows > 0;
}

async function dbReleaseLock(kind: LockKind, key: string, workerId: string, jobId: number): Promise<boolean> {
  const p = getPool();
  if (!p) {
    throw new Error("MYSQL configurado e obrigatorio para locks");
  }

  const table = kind === "issue" ? "issue_locks" : "codebase_locks";
  const keyColumn = kind === "issue" ? "issue_key" : "codebase_name";

  const [result] = await p.execute<mysql.ResultSetHeader>(
    `DELETE FROM ${table}
      WHERE ${keyColumn} = ?
        AND owner_worker_id = ?
        AND owner_job_id = ?`,
    [key, workerId, jobId]
  );

  return result.affectedRows > 0;
}

export async function dbAcquireIssueLock(
  issueKey: string,
  workerId: string,
  jobId: number,
  leaseMs: number
): Promise<boolean> {
  return dbAcquireLock("issue", issueKey, workerId, jobId, leaseMs);
}

export async function dbRenewIssueLock(
  issueKey: string,
  workerId: string,
  jobId: number,
  leaseMs: number
): Promise<boolean> {
  return dbRenewLock("issue", issueKey, workerId, jobId, leaseMs);
}

export async function dbReleaseIssueLock(issueKey: string, workerId: string, jobId: number): Promise<boolean> {
  return dbReleaseLock("issue", issueKey, workerId, jobId);
}

export async function dbAcquireCodebaseLock(
  codebaseName: string,
  workerId: string,
  jobId: number,
  leaseMs: number
): Promise<boolean> {
  return dbAcquireLock("codebase", codebaseName, workerId, jobId, leaseMs);
}

export async function dbRenewCodebaseLock(
  codebaseName: string,
  workerId: string,
  jobId: number,
  leaseMs: number
): Promise<boolean> {
  return dbRenewLock("codebase", codebaseName, workerId, jobId, leaseMs);
}

export async function dbReleaseCodebaseLock(
  codebaseName: string,
  workerId: string,
  jobId: number
): Promise<boolean> {
  return dbReleaseLock("codebase", codebaseName, workerId, jobId);
}

type CheckpointToolProgress = NonNullable<ExecutionCheckpointState["toolProgress"]>[number];

interface CheckpointStateDelta {
  core?: Partial<ExecutionCheckpointState["core"]>;
  context?: Partial<ExecutionCheckpointState["context"]>;
  toolProgress?:
    | { mode: "append"; entries: CheckpointToolProgress[] }
    | { mode: "replace"; entries: CheckpointToolProgress[] }
    | { mode: "clear" };
}

interface PersistedCheckpointEnvelope {
  format: "checkpoint_v2";
  kind: "full" | "delta";
  stateHash: string;
  savedAt: string;
  baseSeq?: number;
  state?: ExecutionCheckpointState;
  delta?: CheckpointStateDelta;
  validity: {
    hashAlgorithm: "sha256";
    deltaApplied: boolean;
    changedFields: string[];
  };
}

function hashCheckpointState(state: ExecutionCheckpointState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function asCheckpointEnvelope(value: unknown): PersistedCheckpointEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as Record<string, unknown>;
  if (maybe.format !== "checkpoint_v2") return null;
  if (maybe.kind !== "full" && maybe.kind !== "delta") return null;
  if (typeof maybe.stateHash !== "string") return null;
  if (typeof maybe.savedAt !== "string") return null;
  if (!maybe.validity || typeof maybe.validity !== "object") return null;
  return maybe as unknown as PersistedCheckpointEnvelope;
}

function sameToolProgressEntry(a: CheckpointToolProgress, b: CheckpointToolProgress): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function computeStateDelta(
  previousState: ExecutionCheckpointState,
  nextState: ExecutionCheckpointState
): { delta: CheckpointStateDelta | null; changedFields: string[] } {
  const changedFields: string[] = [];
  const coreDelta: Partial<ExecutionCheckpointState["core"]> = {};
  const contextDelta: Partial<ExecutionCheckpointState["context"]> = {};

  for (const key of Object.keys(nextState.core) as Array<keyof ExecutionCheckpointState["core"]>) {
    if (previousState.core[key] !== nextState.core[key]) {
      (coreDelta as any)[key] = nextState.core[key];
      changedFields.push(`core.${String(key)}`);
    }
  }

  const contextKeys: Array<keyof ExecutionCheckpointState["context"]> = [
    "summary",
    "snapshotText",
    "lastCriticalEvent",
    "metadata",
  ];
  for (const key of contextKeys) {
    const prevValue = previousState.context[key];
    const nextValue = nextState.context[key];
    if (JSON.stringify(prevValue) !== JSON.stringify(nextValue)) {
      (contextDelta as any)[key] = nextValue;
      changedFields.push(`context.${String(key)}`);
    }
  }

  const previousProgress = previousState.toolProgress ?? [];
  const nextProgress = nextState.toolProgress ?? [];
  let toolProgressDelta: CheckpointStateDelta["toolProgress"] | undefined;

  const equalLength = previousProgress.length === nextProgress.length;
  const fullyEqual =
    equalLength && previousProgress.every((entry, index) => sameToolProgressEntry(entry, nextProgress[index]!));

  if (!fullyEqual) {
    const canAppend =
      nextProgress.length >= previousProgress.length &&
      previousProgress.every((entry, index) => sameToolProgressEntry(entry, nextProgress[index]!));

    if (canAppend && nextProgress.length > previousProgress.length) {
      toolProgressDelta = {
        mode: "append",
        entries: nextProgress.slice(previousProgress.length),
      };
      changedFields.push("toolProgress.append");
    } else if (nextProgress.length === 0 && previousProgress.length > 0) {
      toolProgressDelta = { mode: "clear" };
      changedFields.push("toolProgress.clear");
    } else {
      toolProgressDelta = {
        mode: "replace",
        entries: nextProgress,
      };
      changedFields.push("toolProgress.replace");
    }
  }

  const hasCore = Object.keys(coreDelta).length > 0;
  const hasContext = Object.keys(contextDelta).length > 0;
  if (!hasCore && !hasContext && !toolProgressDelta) {
    return { delta: null, changedFields: [] };
  }

  return {
    delta: {
      ...(hasCore ? { core: coreDelta } : {}),
      ...(hasContext ? { context: contextDelta } : {}),
      ...(toolProgressDelta ? { toolProgress: toolProgressDelta } : {}),
    },
    changedFields,
  };
}

function applyStateDelta(baseState: ExecutionCheckpointState, delta: CheckpointStateDelta): ExecutionCheckpointState {
  const nextState: ExecutionCheckpointState = {
    core: {
      ...baseState.core,
      ...(delta.core ?? {}),
    },
    context: {
      ...baseState.context,
      ...(delta.context ?? {}),
    },
    toolProgress: baseState.toolProgress ? [...baseState.toolProgress] : [],
  };

  if (delta.toolProgress) {
    if (delta.toolProgress.mode === "append") {
      nextState.toolProgress = [...(nextState.toolProgress ?? []), ...delta.toolProgress.entries];
    } else if (delta.toolProgress.mode === "replace") {
      nextState.toolProgress = [...delta.toolProgress.entries];
    } else {
      nextState.toolProgress = [];
    }
  }

  return nextState;
}

function decodeLegacyOrFullState(rawState: unknown): ExecutionCheckpointState | null {
  const parsed = safeJsonParse(rawState);
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = asCheckpointEnvelope(parsed);
  if (envelope?.kind === "full" && envelope.state) {
    return envelope.state;
  }
  const maybeState = parsed as ExecutionCheckpointState;
  if (!maybeState.core || !maybeState.context) return null;
  return maybeState;
}

async function reconstructCheckpointStateAtSeq(
  p: mysql.Pool,
  jobId: number,
  targetSeq: number
): Promise<ExecutionCheckpointState | null> {
  const [rows] = await p.query<mysql.RowDataPacket[]>(
    `SELECT checkpoint_seq, state_json
       FROM agent_execution_checkpoints
      WHERE job_id = ?
        AND is_valid = 1
        AND checkpoint_seq <= ?
      ORDER BY checkpoint_seq ASC, id ASC`,
    [jobId, targetSeq]
  );

  const statesBySeq = new Map<number, ExecutionCheckpointState>();
  for (const row of rows) {
    const seq = Number(row.checkpoint_seq);
    const parsed = safeJsonParse(row.state_json);
    const envelope = asCheckpointEnvelope(parsed);

    if (!envelope) {
      const legacy = decodeLegacyOrFullState(parsed);
      if (legacy) {
        statesBySeq.set(seq, legacy);
      }
      continue;
    }

    if (envelope.kind === "full") {
      if (!envelope.state) continue;
      if (hashCheckpointState(envelope.state) !== envelope.stateHash) continue;
      statesBySeq.set(seq, envelope.state);
      continue;
    }

    if (!envelope.delta || typeof envelope.baseSeq !== "number") continue;
    const baseState = statesBySeq.get(envelope.baseSeq);
    if (!baseState) continue;
    const rebuilt = applyStateDelta(baseState, envelope.delta);
    if (hashCheckpointState(rebuilt) !== envelope.stateHash) continue;
    statesBySeq.set(seq, rebuilt);
  }

  return statesBySeq.get(targetSeq) ?? null;
}

export async function dbSaveExecutionCheckpoint(input: SaveExecutionCheckpointInput): Promise<number | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const [seqRows] = await p.query<mysql.RowDataPacket[]>(
      `SELECT MAX(checkpoint_seq) AS latest_seq
         FROM agent_execution_checkpoints
        WHERE job_id = ?`,
      [input.jobId]
    );
    const latestSeq = Number(seqRows[0]?.latest_seq ?? 0);
    if (shouldRejectOutOfOrderCheckpoint(latestSeq, input.checkpointSeq)) {
      console.warn(
        `[db] ignoring out-of-order checkpoint job=${input.jobId} seq=${input.checkpointSeq} latest_seq=${latestSeq}`
      );
      return null;
    }

    const governed = governCheckpointState(input.state);
    let persistedStateJson = governed.json;

    if (latestSeq > 0) {
      const previousState = await reconstructCheckpointStateAtSeq(p, input.jobId, latestSeq);
      if (previousState) {
        const { delta, changedFields } = computeStateDelta(previousState, governed.state as ExecutionCheckpointState);
        if (delta) {
          const fullEnvelope: PersistedCheckpointEnvelope = {
            format: "checkpoint_v2",
            kind: "full",
            state: governed.state as ExecutionCheckpointState,
            stateHash: hashCheckpointState(governed.state as ExecutionCheckpointState),
            savedAt: new Date().toISOString(),
            validity: {
              hashAlgorithm: "sha256",
              deltaApplied: false,
              changedFields,
            },
          };
          const deltaEnvelope: PersistedCheckpointEnvelope = {
            format: "checkpoint_v2",
            kind: "delta",
            baseSeq: latestSeq,
            delta,
            stateHash: hashCheckpointState(governed.state as ExecutionCheckpointState),
            savedAt: new Date().toISOString(),
            validity: {
              hashAlgorithm: "sha256",
              deltaApplied: true,
              changedFields,
            },
          };

          const fullJson = JSON.stringify(fullEnvelope);
          const deltaJson = JSON.stringify(deltaEnvelope);
          persistedStateJson = deltaJson.length < fullJson.length ? deltaJson : fullJson;
        }
      }
    }

    if (persistedStateJson === governed.json) {
      const envelope: PersistedCheckpointEnvelope = {
        format: "checkpoint_v2",
        kind: "full",
        state: governed.state as ExecutionCheckpointState,
        stateHash: hashCheckpointState(governed.state as ExecutionCheckpointState),
        savedAt: new Date().toISOString(),
        validity: {
          hashAlgorithm: "sha256",
          deltaApplied: false,
          changedFields: ["core", "context", "toolProgress"],
        },
      };
      persistedStateJson = JSON.stringify(envelope);
    }

    const [result] = await p.execute<mysql.ResultSetHeader>(
      `INSERT INTO agent_execution_checkpoints
        (job_id, issue_key, agent_type, checkpoint_version, checkpoint_seq, state_json, is_valid)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 1)
       ON DUPLICATE KEY UPDATE
         state_json = VALUES(state_json),
         checkpoint_version = VALUES(checkpoint_version),
         is_valid = 1,
         invalid_reason = NULL`,
      [
        input.jobId,
        input.issueKey,
        input.agentType,
        input.checkpointVersion,
        input.checkpointSeq,
        persistedStateJson,
      ]
    );

    const maxPerJob = getCheckpointMaxPerJob();
    if (maxPerJob > 0) {
      const pruneLimit = Math.max(1, Math.floor(maxPerJob));
      await p.execute(
        `DELETE FROM agent_execution_checkpoints
          WHERE job_id = ?
            AND id NOT IN (
              SELECT id FROM (
                SELECT id
                  FROM agent_execution_checkpoints
                 WHERE job_id = ?
                 ORDER BY checkpoint_seq DESC, id DESC
                 LIMIT ${pruneLimit}
              ) AS latest
            )`,
        [input.jobId, input.jobId]
      );
    }

    if (governed.truncated || governed.redactedFields > 0 || governed.droppedToolCachedResults > 0) {
      console.log(
        `[db] checkpoint governance job=${input.jobId} seq=${input.checkpointSeq}` +
          ` truncated=${governed.truncated}` +
          ` redacted_fields=${governed.redactedFields}` +
          ` dropped_cached_results=${governed.droppedToolCachedResults}`
      );
    }

    if (result.insertId && result.insertId > 0) {
      return Number(result.insertId);
    }

    const [rows] = await p.query<mysql.RowDataPacket[]>(
      `SELECT id
         FROM agent_execution_checkpoints
        WHERE job_id = ?
          AND checkpoint_seq = ?
        LIMIT 1`,
      [input.jobId, input.checkpointSeq]
    );
    const row = rows[0];
    return row ? Number(row.id) : null;
  } catch (err) {
    console.error("[db] save checkpoint error:", err);
    return null;
  }
}

export async function dbGetLatestExecutionCheckpoint(jobId: number): Promise<ExecutionCheckpointRecord | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const [rows] = await p.query<mysql.RowDataPacket[]>(
      `SELECT id, job_id, issue_key, agent_type, checkpoint_version, checkpoint_seq,
              state_json, is_valid, invalid_reason, created_at, updated_at
         FROM agent_execution_checkpoints
        WHERE job_id = ?
          AND is_valid = 1
        ORDER BY checkpoint_seq DESC, id DESC
        LIMIT 1`,
      [jobId]
    );
    const row = rows[0];
    if (!row) return null;

    const checkpointSeq = Number(row.checkpoint_seq);
    const parsedState = await reconstructCheckpointStateAtSeq(p, jobId, checkpointSeq);
    if (!parsedState) {
      console.warn(`[db] checkpoint reconstruction failed job=${jobId} seq=${checkpointSeq}`);
      return null;
    }

    return {
      id: Number(row.id),
      jobId: Number(row.job_id),
      issueKey: String(row.issue_key),
      agentType: row.agent_type as AgentType,
      checkpointVersion: Number(row.checkpoint_version),
      checkpointSeq,
      state: parsedState,
      isValid: Number(row.is_valid) === 1,
      invalidReason: row.invalid_reason == null ? null : String(row.invalid_reason),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  } catch (err) {
    console.error("[db] load checkpoint error:", err);
    return null;
  }
}

export async function dbInvalidateExecutionCheckpointsByJob(jobId: number, reason: string): Promise<number> {
  const p = getPool();
  if (!p) return 0;
  try {
    const [result] = await p.execute<mysql.ResultSetHeader>(
      `UPDATE agent_execution_checkpoints
          SET is_valid = 0,
              invalid_reason = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
          AND is_valid = 1`,
      [reason.slice(0, 255), jobId]
    );
    return Number(result.affectedRows ?? 0);
  } catch (err) {
    console.error("[db] invalidate checkpoint error:", err);
    return 0;
  }
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Abre uma sessão de agente no banco.
 *
 * @param agentType  "reviewer" | "analyst" | "implementor"
 * @param issueKey   Chave do issue Jira (ex: VAT-4)
 * @param model      Modelo Claude utilizado
 */
export async function dbInsertSession(
  agentType: string,
  issueKey: string,
  model: string
): Promise<number | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const [result] = await p.execute<mysql.ResultSetHeader>(
      `INSERT INTO api_sessions (prompt, agent_type, issue_key, model, status)
       VALUES (?, ?, ?, ?, ?)`,
      [`${agentType}:${issueKey}`, agentType, issueKey, model, "running"]
    );
    return result.insertId;
  } catch (err) {
    console.error("[db] insert error:", err);
    return null;
  }
}

/**
 * Atualiza os contadores acumulados após cada turno do agente.
 * Chamado mid-run para que interrupções não percam dados de custo/tokens.
 *
 * @param codebase  Nome(s) do codebase sendo analisado/implementado (opcional)
 */
export async function dbUpdateSession(
  rowId: number,
  turns: number,
  costUsd: number,
  usage: TokenUsage,
  codebase?: string | null
): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute(
      `UPDATE api_sessions
          SET num_turns           = ?,
              total_cost_usd      = ?,
              input_tokens        = ?,
              output_tokens       = ?,
              cache_read_tokens   = ?,
              cache_creation_tokens = ?,
              codebase            = COALESCE(?, codebase)
        WHERE id = ?`,
      [
        turns,
        costUsd,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheCreationTokens,
        codebase ?? null,
        rowId,
      ]
    );
  } catch (err) {
    console.error("[db] update error:", err);
  }
}

/**
 * Finaliza a sessão com o status final e o timestamp de conclusão.
 * Chamado no bloco finally de cada agente.
 */
export async function dbFinishSession(
  rowId: number,
  status: string
): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute(
      `UPDATE api_sessions SET status = ?, finished_at = NOW() WHERE id = ?`,
      [status, rowId]
    );
  } catch (err) {
    console.error("[db] finish error:", err);
  }
}

export async function dbClose(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
