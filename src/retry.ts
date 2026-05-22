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
