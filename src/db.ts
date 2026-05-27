import mysql from "mysql2/promise";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

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
