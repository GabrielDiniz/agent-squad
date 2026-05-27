const is429 = (err: unknown) =>
  String(err).includes("429") || String(err).includes("rate limit");

export async function withRateLimit<T>(
  fn: () => Promise<T>,
  maxRetries = 4
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!is429(err) || attempt >= maxRetries) throw err;
      const waitSec = 60 * (attempt + 1);
      console.log(
        `[rate-limit] 429 — aguardando ${waitSec}s (tentativa ${attempt + 1}/${maxRetries})...`
      );
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
}

// ─── Dynamic inter-turn delay ─────────────────────────────────────────────────

/**
 * Limiar (%) de tokens restantes abaixo do qual o agente espera o reset da janela.
 * Configurável via RATELIMIT_TOKENS_THRESHOLD_PCT (padrão: 15).
 */
const TOKENS_THRESHOLD_PCT =
  Number(process.env.RATELIMIT_TOKENS_THRESHOLD_PCT ?? "15") / 100;

/**
 * Delay mínimo entre turnos mesmo quando há capacidade de sobra.
 * Serve de buffer contra clock drift e rajadas de pequenas respostas.
 */
const MIN_DELAY_MS = 500;

interface RateLimitHeaders {
  get(name: string): string | null;
}

/**
 * Lê os headers de rate-limit da resposta Anthropic e calcula quantos ms
 * o agente deve esperar antes do próximo turno.
 *
 * Prioridade:
 *   1. requests restantes < 2  → espera até o reset de requests
 *   2. tokens restantes < threshold  → espera até o reset de tokens
 *   3. capacidade normal  → MIN_DELAY_MS (500 ms)
 */
function computeWaitMs(headers: RateLimitHeaders): {
  waitMs: number;
  reason: "requests" | "tokens" | "ok";
  tokensRemaining: number;
  tokensLimit: number;
  requestsRemaining: number;
} {
  const tokensRemaining = Number(
    headers.get("anthropic-ratelimit-tokens-remaining") ?? "NaN"
  );
  const tokensLimit = Number(
    headers.get("anthropic-ratelimit-tokens-limit") ?? "NaN"
  );
  const tokensReset = headers.get("anthropic-ratelimit-tokens-reset");
  const reqRemaining = Number(
    headers.get("anthropic-ratelimit-requests-remaining") ?? "NaN"
  );
  const reqReset = headers.get("anthropic-ratelimit-requests-reset");

  // Prioridade 1: requests quase esgotados
  if (!Number.isNaN(reqRemaining) && reqRemaining < 2 && reqReset) {
    const ms = new Date(reqReset).getTime() - Date.now() + 500;
    return {
      waitMs: Math.max(MIN_DELAY_MS, ms),
      reason: "requests",
      tokensRemaining,
      tokensLimit,
      requestsRemaining: reqRemaining,
    };
  }

  // Prioridade 2: tokens abaixo do limiar
  if (
    !Number.isNaN(tokensRemaining) &&
    !Number.isNaN(tokensLimit) &&
    tokensLimit > 0 &&
    tokensRemaining / tokensLimit < TOKENS_THRESHOLD_PCT &&
    tokensReset
  ) {
    const ms = new Date(tokensReset).getTime() - Date.now() + 500;
    return {
      waitMs: Math.max(MIN_DELAY_MS, ms),
      reason: "tokens",
      tokensRemaining,
      tokensLimit,
      requestsRemaining: reqRemaining,
    };
  }

  return {
    waitMs: MIN_DELAY_MS,
    reason: "ok",
    tokensRemaining,
    tokensLimit,
    requestsRemaining: reqRemaining,
  };
}

/**
 * Aguarda o tempo calculado com base nos headers de rate-limit da resposta
 * anterior. Loga uma linha resumida do estado atual.
 *
 * @param agent  Nome do agente para prefixo do log (ex: "implementor")
 * @param headers  Headers da resposta HTTP da Anthropic
 */
export async function interTurnDelay(
  agent: string,
  headers: RateLimitHeaders
): Promise<void> {
  const { waitMs, reason, tokensRemaining, tokensLimit, requestsRemaining } =
    computeWaitMs(headers);

  const tokensPct =
    !Number.isNaN(tokensRemaining) && !Number.isNaN(tokensLimit) && tokensLimit > 0
      ? `${Math.round((tokensRemaining / tokensLimit) * 100)}%`
      : "?%";

  const tag =
    reason === "requests"
      ? "⚠ req limit"
      : reason === "tokens"
      ? "⚠ token limit"
      : "✓";

  console.log(
    `[${agent}] rate-limit ${tag} | tokens: ${tokensRemaining}/${tokensLimit} (${tokensPct})` +
      ` req: ${requestsRemaining} | wait: ${(waitMs / 1000).toFixed(1)}s`
  );

  await new Promise((r) => setTimeout(r, waitMs));
}
