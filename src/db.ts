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

export async function dbInsertSession(prompt: string): Promise<number | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const [result] = await p.execute<mysql.ResultSetHeader>(
      "INSERT INTO api_sessions (prompt, status) VALUES (?, ?)",
      [prompt, "running"]
    );
    return result.insertId;
  } catch (err) {
    console.error("[db] insert error:", err);
    return null;
  }
}

export async function dbFinishSession(
  rowId: number,
  sessionId: string,
  status: string,
  numTurns?: number,
  totalCostUsd?: number,
  usage?: TokenUsage
): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute(
      `UPDATE api_sessions
         SET session_id = ?, status = ?, num_turns = ?, total_cost_usd = ?,
             input_tokens = ?, output_tokens = ?,
             cache_read_tokens = ?, cache_creation_tokens = ?,
             finished_at = NOW()
       WHERE id = ?`,
      [
        sessionId,
        status,
        numTurns ?? null,
        totalCostUsd ?? null,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheCreationTokens ?? null,
        rowId,
      ]
    );
  } catch (err) {
    console.error("[db] update error:", err);
  }
}

export async function dbClose(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
