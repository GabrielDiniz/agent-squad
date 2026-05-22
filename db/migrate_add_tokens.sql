-- Migração: adiciona colunas de uso de tokens em api_sessions
-- Execute uma vez: docker exec agent-squad-mysql mysql -uroot -prootpassword agent_squad < db/migrate_add_tokens.sql

ALTER TABLE api_sessions
  ADD COLUMN IF NOT EXISTS input_tokens          INT UNSIGNED DEFAULT NULL AFTER total_cost_usd,
  ADD COLUMN IF NOT EXISTS output_tokens         INT UNSIGNED DEFAULT NULL AFTER input_tokens,
  ADD COLUMN IF NOT EXISTS cache_read_tokens     INT UNSIGNED DEFAULT NULL AFTER output_tokens,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INT UNSIGNED DEFAULT NULL AFTER cache_read_tokens;

-- Atualiza as views para incluir tokens
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
