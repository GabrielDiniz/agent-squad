CREATE TABLE IF NOT EXISTS api_sessions (
  id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id                VARCHAR(100)          DEFAULT NULL,
  prompt                    TEXT                  NOT NULL,
  agent_type                VARCHAR(20)           DEFAULT NULL,
  issue_key                 VARCHAR(50)           DEFAULT NULL,
  model                     VARCHAR(100)          DEFAULT NULL,
  codebase                  VARCHAR(500)          DEFAULT NULL,
  status                    VARCHAR(20)           NOT NULL DEFAULT 'running',
  num_turns                 INT UNSIGNED          DEFAULT NULL,
  total_cost_usd            DECIMAL(14, 8)        DEFAULT NULL,
  input_tokens              INT UNSIGNED          DEFAULT NULL,
  output_tokens             INT UNSIGNED          DEFAULT NULL,
  cache_read_tokens         INT UNSIGNED          DEFAULT NULL,
  cache_creation_tokens     INT UNSIGNED          DEFAULT NULL,
  created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at               TIMESTAMP             DEFAULT NULL,
  INDEX idx_session_id  (session_id),
  INDEX idx_issue_key   (issue_key),
  INDEX idx_agent_type  (agent_type),
  INDEX idx_created_at  (created_at),
  INDEX idx_status      (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- View: custo por dia (inclui sessões interrompidas via num_turns IS NOT NULL)
CREATE OR REPLACE VIEW daily_costs AS
SELECT
  DATE(created_at)                                          AS day,
  COUNT(*)                                                  AS total_calls,
  SUM(num_turns)                                            AS total_turns,
  SUM(total_cost_usd)                                       AS total_cost_usd,
  AVG(total_cost_usd)                                       AS avg_cost_per_call,
  SUM(input_tokens)                                         AS total_input_tokens,
  SUM(output_tokens)                                        AS total_output_tokens,
  SUM(cache_read_tokens)                                    AS total_cache_read_tokens,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)         AS error_count
FROM api_sessions
GROUP BY DATE(created_at)
ORDER BY day DESC;

-- View: custo do mês corrente
CREATE OR REPLACE VIEW monthly_costs AS
SELECT
  DATE_FORMAT(created_at, '%Y-%m')    AS month,
  COUNT(*)                            AS total_calls,
  SUM(num_turns)                      AS total_turns,
  SUM(total_cost_usd)                 AS total_cost_usd,
  AVG(total_cost_usd)                 AS avg_cost_per_call,
  SUM(input_tokens)                   AS total_input_tokens,
  SUM(output_tokens)                  AS total_output_tokens,
  SUM(cache_read_tokens)              AS total_cache_read_tokens
FROM api_sessions
GROUP BY DATE_FORMAT(created_at, '%Y-%m')
ORDER BY month DESC;

-- View: histórico por issue — custo total por demanda em todos os agentes
CREATE OR REPLACE VIEW issue_costs AS
SELECT
  issue_key,
  agent_type,
  model,
  codebase,
  status,
  num_turns,
  total_cost_usd,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_creation_tokens,
  created_at,
  finished_at,
  TIMESTAMPDIFF(SECOND, created_at, COALESCE(finished_at, NOW())) AS duration_sec
FROM api_sessions
ORDER BY created_at DESC;

CREATE TABLE IF NOT EXISTS queue_jobs (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_work_state (
  issue_key                 VARCHAR(50)           PRIMARY KEY,
  latest_event_version      BIGINT UNSIGNED       NOT NULL DEFAULT 0,
  latest_job_id             BIGINT UNSIGNED       DEFAULT NULL,
  current_state             VARCHAR(20)           NOT NULL DEFAULT 'idle',
  current_agent_type        VARCHAR(20)           DEFAULT NULL,
  updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_issue_work_state_job (latest_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS codebase_locks (
  codebase_name             VARCHAR(191)          PRIMARY KEY,
  owner_worker_id           VARCHAR(100)          NOT NULL,
  owner_job_id              BIGINT UNSIGNED       NOT NULL,
  lease_until               DATETIME(3)           NOT NULL,
  heartbeat_at              DATETIME(3)           NOT NULL,
  created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_codebase_locks_lease (lease_until),
  INDEX idx_codebase_locks_owner (owner_worker_id, owner_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_locks (
  issue_key                 VARCHAR(50)           PRIMARY KEY,
  owner_worker_id           VARCHAR(100)          NOT NULL,
  owner_job_id              BIGINT UNSIGNED       NOT NULL,
  lease_until               DATETIME(3)           NOT NULL,
  heartbeat_at              DATETIME(3)           NOT NULL,
  created_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_issue_locks_lease (lease_until),
  INDEX idx_issue_locks_owner (owner_worker_id, owner_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_execution_checkpoints (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW queue_jobs_overview AS
SELECT
  state,
  COUNT(*) AS total,
  MIN(next_run_at) AS next_eligible_at,
  MAX(updated_at) AS last_update_at
FROM queue_jobs
GROUP BY state;

CREATE OR REPLACE VIEW queue_jobs_backlog_by_issue AS
SELECT
  issue_key,
  state,
  COUNT(*) AS total,
  MAX(event_version) AS max_event_version,
  MAX(updated_at) AS last_update_at
FROM queue_jobs
GROUP BY issue_key, state
ORDER BY last_update_at DESC;
