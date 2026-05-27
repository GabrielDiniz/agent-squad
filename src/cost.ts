import type { TokenUsage } from "./db.js";

/**
 * Preços por milhão de tokens (USD) por modelo.
 * Fonte: https://www.anthropic.com/pricing
 * Atualizar se a Anthropic alterar os preços.
 */
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-haiku-4-5-20251001": {
    input: 1.00,
    output: 5.00,
    cacheWrite: 1.25,
    cacheRead: 0.10,
  },
  "claude-sonnet-4-6": {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,
    cacheRead: 0.30,
  },
  "claude-opus-4-7": {
    input: 5.00,
    output: 25.00,
    cacheWrite: 6.25,
    cacheRead: 0.50,
  },
};

/**
 * Calcula o custo total de uma sessão com base nos tokens consumidos.
 *
 * O campo `inputTokens` da API já exclui tokens de cache — cada categoria
 * é cobrada pelo seu próprio preço:
 *   - inputTokens         → preço de input normal
 *   - cacheCreationTokens → preço de escrita de cache (cache write)
 *   - cacheReadTokens     → preço de leitura de cache (muito mais barato)
 *   - outputTokens        → preço de output
 */
export function calculateCostUsd(model: string, usage: TokenUsage): number {
  const prices = MODEL_PRICING[model];

  if (!prices) {
    console.warn(`[cost] modelo "${model}" não tem preço cadastrado — custo não calculado`);
    return 0;
  }

  const M = 1_000_000;
  return (
    (usage.inputTokens         * prices.input      +
     usage.cacheCreationTokens * prices.cacheWrite  +
     usage.cacheReadTokens     * prices.cacheRead   +
     usage.outputTokens        * prices.output) / M
  );
}
