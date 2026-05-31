import { afterEach, describe, expect, it } from "vitest";
import {
  governCheckpointState,
  isCheckpointVersionCompatible,
  shouldRejectOutOfOrderCheckpoint,
  type ExecutionCheckpointStateLike,
} from "../checkpoint-governance.js";

const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
});

function baseState(): ExecutionCheckpointStateLike {
  return {
    core: {
      turns: 3,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 4,
      softBudgetMode: false,
      maxTokenRecoveries: 1,
      promptMode: "balanced",
    },
    context: {
      summary: "checkpoint normal",
      metadata: {},
    },
    toolProgress: [],
  };
}

describe("checkpoint governance", () => {
  it("redige campos sensíveis por chave e por conteúdo", () => {
    const state = baseState();
    state.context.metadata = {
      apiToken: "abc123",
      nested: {
        password: "secret",
      },
      raw: "github_pat_abcd1234567890_abcd1234567890",
    };

    const governed = governCheckpointState(state);

    expect(governed.redactedFields).toBeGreaterThan(0);
    expect(governed.json).not.toContain("github_pat_");
    expect(governed.json).toContain("[REDACTED]");
  });

  it("trunca payload grande preservando JSON válido", () => {
    process.env.RESUME_CHECKPOINT_MAX_STATE_CHARS = "600";
    process.env.RESUME_CHECKPOINT_MAX_STRING_CHARS = "80";

    const state = baseState();
    state.context.summary = "x".repeat(2000);
    state.toolProgress = [
      {
        toolName: "bash_read",
        status: "completed",
        cacheKey: "bash_read:a",
        cachedResult: "y".repeat(3000),
      },
    ];

    const governed = governCheckpointState(state);

    expect(governed.truncated).toBe(true);
    expect(() => JSON.parse(governed.json)).not.toThrow();
    expect(governed.json.length).toBeLessThanOrEqual(600 + 300);
  });

  it("valida compatibilidade de versão com faixa configurada", () => {
    process.env.RESUME_CHECKPOINT_VERSION = "3";
    process.env.RESUME_CHECKPOINT_MIN_COMPAT_VERSION = "2";

    expect(isCheckpointVersionCompatible(1)).toBe(false);
    expect(isCheckpointVersionCompatible(2)).toBe(true);
    expect(isCheckpointVersionCompatible(3)).toBe(true);
    expect(isCheckpointVersionCompatible(4)).toBe(false);
  });

  it("rejeita sequência fora de ordem para evitar corrupção em retry duplicado", () => {
    expect(shouldRejectOutOfOrderCheckpoint(0, 1)).toBe(false);
    expect(shouldRejectOutOfOrderCheckpoint(4, 4)).toBe(false);
    expect(shouldRejectOutOfOrderCheckpoint(4, 5)).toBe(false);
    expect(shouldRejectOutOfOrderCheckpoint(4, 3)).toBe(true);
  });
});
