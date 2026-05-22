CREATE TABLE IF NOT EXISTS api_sessions (
  id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id                VARCHAR(100)          DEFAULT NULL,
  prompt                    TEXT                  NOT NULL,
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
  INDEX idx_created_at  (created_at),
  INDEX idx_status      (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- View para monitorar custos e tokens agregados por dia
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
WHERE finished_at IS NOT NULL
GROUP BY DATE(created_at)
ORDER BY day DESC;

-- View para monitorar custos do mês corrente
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
WHERE finished_at IS NOT NULL
GROUP BY DATE_FORMAT(created_at, '%Y-%m')
ORDER BY month DESC;
