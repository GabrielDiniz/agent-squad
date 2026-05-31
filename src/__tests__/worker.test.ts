import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LockBackend, QueueBackend, QueueJobRecord } from "../queue/backend.js";

const reviewIssueMock = vi.fn();
const analyzeIssueMock = vi.fn();
const implementIssueMock = vi.fn();

vi.mock("../codebases.js", () => ({
  resolveCodebases: () => [{ name: "app-main" }],
}));

vi.mock("../agents/reviewer.js", () => ({
  reviewIssue: reviewIssueMock,
}));

vi.mock("../agents/analyst.js", () => ({
  analyzeIssue: analyzeIssueMock,
}));

vi.mock("../agents/implementor.js", () => ({
  implementIssue: implementIssueMock,
}));

const { classifyJobError, computeRetryDelayMs, processClaimedJob } = await import("../worker.js");

function makeQueueBackendMocks() {
  return {
    claimNextJob: vi.fn(async () => null),
    enqueueJob: vi.fn(async () => ({ jobId: 1, deduped: false })),
    renewJobLease: vi.fn(async () => true),
    completeJob: vi.fn(async () => true),
    retryJob: vi.fn(async () => true),
    failJob: vi.fn(async () => true),
    getJobState: vi.fn(async () => "running"),
    isJobSuperseded: vi.fn(async () => false),
    markJobStale: vi.fn(async () => true),
    markJobCancelled: vi.fn(async () => true),
    saveExecutionCheckpoint: vi.fn(async () => 1),
    getLatestExecutionCheckpoint: vi.fn(async () => null),
    invalidateExecutionCheckpoints: vi.fn(async () => 0),
  } satisfies Record<keyof QueueBackend, any>;
}

function makeLockBackendMocks() {
  return {
    acquireIssueLock: vi.fn(async () => true),
    renewIssueLock: vi.fn(async () => true),
    releaseIssueLock: vi.fn(async () => true),
    acquireCodebaseLock: vi.fn(async () => true),
    renewCodebaseLock: vi.fn(async () => true),
    releaseCodebaseLock: vi.fn(async () => true),
  } satisfies Record<keyof LockBackend, any>;
}

const baseConfig = {
  workerId: "test-worker",
  pollMs: 1000,
  concurrency: 1,
  leaseMs: 30000,
  retryBaseMs: 2000,
  retryMaxMs: 300000,
};

function makeJob(partial?: Partial<QueueJobRecord>): QueueJobRecord {
  return {
    id: 10,
    issueKey: "VAT-10",
    agentType: "reviewer",
    triggerStatus: "Em Revisão",
    eventVersion: 1,
    state: "running",
    attempts: 1,
    maxAttempts: 3,
    ...partial,
  };
}

describe("worker helpers", () => {
  it("classifica falhas de rede como transient", () => {
    expect(classifyJobError(new Error("timeout connecting to upstream"))).toBe("transient");
    expect(classifyJobError(new Error("HTTP 429 too many requests"))).toBe("transient");
  });

  it("classifica erros de validação como permanent", () => {
    expect(classifyJobError(new Error("payload invalido: campo ausente"))).toBe("permanent");
  });

  it("calcula backoff exponencial com jitter", () => {
    const delay = computeRetryDelayMs(3, 1000, 60000, () => 0.5);
    expect(delay).toBeGreaterThanOrEqual(3200);
    expect(delay).toBeLessThanOrEqual(4800);
  });
});

describe("worker claimed job processing", () => {
  let queue: ReturnType<typeof makeQueueBackendMocks>;
  let locks: ReturnType<typeof makeLockBackendMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = makeQueueBackendMocks();
    locks = makeLockBackendMocks();
    delete process.env.RESUME_ENABLE_FUNCTIONAL;
    delete process.env.REVIEWER_ENABLE_RESUME;
    delete process.env.ANALYST_ENABLE_RESUME;
    delete process.env.IMPLEMENTOR_ENABLE_RESUME;
    delete process.env.RESUME_CHECKPOINT_VERSION;
    delete process.env.RESUME_CHECKPOINT_MIN_COMPAT_VERSION;
    delete process.env.RESUME_REHYDRATE_TIMEOUT_MS;
    delete process.env.REVIEWER_REHYDRATE_TIMEOUT_MS;
    delete process.env.ANALYST_REHYDRATE_TIMEOUT_MS;
    delete process.env.IMPLEMENTOR_REHYDRATE_TIMEOUT_MS;
  });

  it("faz retry para erro transitório quando há tentativas restantes", async () => {
    reviewIssueMock.mockRejectedValueOnce(new Error("timeout from upstream"));

    await processClaimedJob(
      makeJob(),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.retryJob).toHaveBeenCalledTimes(1);
    expect(queue.failJob).not.toHaveBeenCalled();
    expect(queue.completeJob).not.toHaveBeenCalled();
    expect(locks.acquireIssueLock).toHaveBeenCalledTimes(1);
  });

  it("marca failed quando tentativas se esgotam", async () => {
    reviewIssueMock.mockRejectedValueOnce(new Error("timeout from upstream"));

    await processClaimedJob(
      makeJob({ id: 11, attempts: 3, maxAttempts: 3, eventVersion: 2 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.failJob).toHaveBeenCalledTimes(1);
    expect(queue.retryJob).not.toHaveBeenCalled();
    expect(locks.acquireIssueLock).toHaveBeenCalledTimes(1);
  });

  it("completa job quando agente executa com sucesso", async () => {
    analyzeIssueMock.mockResolvedValueOnce(undefined);

    await processClaimedJob(
      makeJob({ id: 12, issueKey: "VAT-12", agentType: "analyst", triggerStatus: "Em Analise Tecnica", eventVersion: 3 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.completeJob).toHaveBeenCalledTimes(1);
    expect(queue.retryJob).not.toHaveBeenCalled();
    expect(queue.failJob).not.toHaveBeenCalled();
    expect(locks.acquireCodebaseLock).toHaveBeenCalledTimes(0);
    expect(queue.getLatestExecutionCheckpoint).toHaveBeenCalledWith(12);
  });

  it("carrega checkpoint passivo quando existir e mantém fluxo normal", async () => {
    reviewIssueMock.mockResolvedValueOnce(undefined);
    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 1,
      jobId: 20,
      issueKey: "VAT-20",
      agentType: "reviewer",
      checkpointVersion: 1,
      checkpointSeq: 3,
      state: {
        core: {
          turns: 3,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          softBudgetMode: false,
          maxTokenRecoveries: 0,
          promptMode: "balanced",
        },
        context: { summary: "checkpoint" },
      },
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 20, issueKey: "VAT-20", eventVersion: 20 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.getLatestExecutionCheckpoint).toHaveBeenCalledWith(20);
    expect(queue.completeJob).toHaveBeenCalledTimes(1);
  });

  it("injeta estado de resume no reviewer quando flags funcionais estao ativas", async () => {
    process.env.RESUME_ENABLE_FUNCTIONAL = "1";
    process.env.REVIEWER_ENABLE_RESUME = "1";
    reviewIssueMock.mockResolvedValueOnce(undefined);

    const checkpointState = {
      core: {
        turns: 4,
        inputTokens: 300,
        outputTokens: 120,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        softBudgetMode: false,
        maxTokenRecoveries: 1,
        promptMode: "balanced",
      },
      context: {
        summary: "estado parcial",
        lastCriticalEvent: "tool_use",
      },
      toolProgress: [],
    };

    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 2,
      jobId: 22,
      issueKey: "VAT-22",
      agentType: "reviewer",
      checkpointVersion: 1,
      checkpointSeq: 4,
      state: checkpointState,
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 22, issueKey: "VAT-22", eventVersion: 22 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(reviewIssueMock).toHaveBeenCalledTimes(1);
    expect(reviewIssueMock).toHaveBeenCalledWith(
      "VAT-22",
      expect.objectContaining({ resumeCheckpointState: checkpointState })
    );
  });

  it("injeta estado de resume no analyst quando flags funcionais estao ativas", async () => {
    process.env.RESUME_ENABLE_FUNCTIONAL = "1";
    process.env.ANALYST_ENABLE_RESUME = "1";
    analyzeIssueMock.mockResolvedValueOnce(undefined);

    const checkpointState = {
      core: {
        turns: 5,
        inputTokens: 420,
        outputTokens: 180,
        cacheReadTokens: 12,
        cacheCreationTokens: 6,
        softBudgetMode: false,
        maxTokenRecoveries: 1,
        promptMode: "balanced" as const,
      },
      context: {
        summary: "estado parcial analyst",
        lastCriticalEvent: "tool_use",
      },
      toolProgress: [],
    };

    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 23,
      jobId: 23,
      issueKey: "VAT-23",
      agentType: "analyst",
      checkpointVersion: 1,
      checkpointSeq: 5,
      state: checkpointState,
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 23, issueKey: "VAT-23", agentType: "analyst", triggerStatus: "Em Analise Tecnica", eventVersion: 23 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(analyzeIssueMock).toHaveBeenCalledTimes(1);
    expect(analyzeIssueMock).toHaveBeenCalledWith(
      "VAT-23",
      expect.objectContaining({ resumeCheckpointState: checkpointState })
    );
  });

  it("injeta estado de resume no implementor quando flags funcionais estao ativas", async () => {
    process.env.RESUME_ENABLE_FUNCTIONAL = "1";
    process.env.IMPLEMENTOR_ENABLE_RESUME = "1";
    implementIssueMock.mockResolvedValueOnce(undefined);

    const checkpointState = {
      core: {
        turns: 6,
        inputTokens: 620,
        outputTokens: 240,
        cacheReadTokens: 18,
        cacheCreationTokens: 8,
        softBudgetMode: true,
        maxTokenRecoveries: 2,
        promptMode: "compact" as const,
      },
      context: {
        summary: "estado parcial implementor",
        lastCriticalEvent: "tool_use",
      },
      toolProgress: [],
    };

    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 24,
      jobId: 24,
      issueKey: "VAT-24",
      agentType: "implementor",
      checkpointVersion: 1,
      checkpointSeq: 6,
      state: checkpointState,
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 24, issueKey: "VAT-24", agentType: "implementor", triggerStatus: "Pronto para Começar", eventVersion: 24 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(implementIssueMock).toHaveBeenCalledTimes(1);
    expect(implementIssueMock).toHaveBeenCalledWith(
      "VAT-24",
      expect.objectContaining({ resumeCheckpointState: checkpointState })
    );
  });

  it("faz fallback cold start quando load de checkpoint falha", async () => {
    reviewIssueMock.mockResolvedValueOnce(undefined);
    queue.getLatestExecutionCheckpoint.mockRejectedValueOnce(new Error("db down"));

    await processClaimedJob(
      makeJob({ id: 21, issueKey: "VAT-21", eventVersion: 21 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.getLatestExecutionCheckpoint).toHaveBeenCalledWith(21);
    expect(queue.completeJob).toHaveBeenCalledTimes(1);
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it("aplica compensação quando save de checkpoint falha no meio da execução", async () => {
    reviewIssueMock.mockImplementationOnce(async (_issueKey: string, options?: any) => {
      await options?.saveExecutionCheckpoint?.(2, {
        core: {
          turns: 2,
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          softBudgetMode: false,
          maxTokenRecoveries: 0,
          promptMode: "balanced",
        },
        context: { summary: "checkpoint parcial" },
        toolProgress: [],
      });
    });
    queue.saveExecutionCheckpoint.mockRejectedValueOnce(new Error("db checkpoint write error"));

    await processClaimedJob(
      makeJob({ id: 26, issueKey: "VAT-26", eventVersion: 26 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.saveExecutionCheckpoint).toHaveBeenCalledTimes(1);
    expect(queue.invalidateExecutionCheckpoints).toHaveBeenCalledWith(
      26,
      expect.stringContaining("checkpoint_save_failed_mid_run")
    );
    expect(queue.completeJob).toHaveBeenCalledTimes(1);
  });

  it("invalida checkpoint incompatível por versão e segue em cold start", async () => {
    process.env.RESUME_ENABLE_FUNCTIONAL = "1";
    process.env.REVIEWER_ENABLE_RESUME = "1";
    process.env.RESUME_CHECKPOINT_VERSION = "1";
    process.env.RESUME_CHECKPOINT_MIN_COMPAT_VERSION = "1";
    reviewIssueMock.mockResolvedValueOnce(undefined);

    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 99,
      jobId: 25,
      issueKey: "VAT-25",
      agentType: "reviewer",
      checkpointVersion: 9,
      checkpointSeq: 4,
      state: {
        core: {
          turns: 4,
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          softBudgetMode: false,
          maxTokenRecoveries: 0,
          promptMode: "balanced",
        },
        context: { summary: "incompatível" },
        toolProgress: [],
      },
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 25, issueKey: "VAT-25", eventVersion: 25 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.invalidateExecutionCheckpoints).toHaveBeenCalledWith(
      25,
      expect.stringContaining("checkpoint_version_incompatible")
    );
    expect(reviewIssueMock).toHaveBeenCalledWith(
      "VAT-25",
      expect.objectContaining({ resumeCheckpointState: null })
    );
  });

  it("faz retry quando issue lock esta ocupado", async () => {
    locks.acquireIssueLock.mockResolvedValueOnce(false);

    await processClaimedJob(
      makeJob({ id: 13, issueKey: "VAT-13", eventVersion: 4 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.retryJob).toHaveBeenCalledTimes(1);
    expect(queue.completeJob).not.toHaveBeenCalled();
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it("adquire codebase lock para job implementor", async () => {
    implementIssueMock.mockResolvedValueOnce(undefined);

    await processClaimedJob(
      makeJob({ id: 14, issueKey: "VAT-14", agentType: "implementor", triggerStatus: "Pronto para Começar", eventVersion: 5 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(locks.acquireCodebaseLock).toHaveBeenCalledTimes(1);
    expect(locks.releaseCodebaseLock).toHaveBeenCalledTimes(1);
    expect(queue.completeJob).toHaveBeenCalledTimes(1);
  });

  it("marca stale quando job foi supersedido antes da execucao", async () => {
    queue.isJobSuperseded.mockResolvedValueOnce(true);

    await processClaimedJob(
      makeJob({ id: 15, issueKey: "VAT-15", eventVersion: 10 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.markJobStale).toHaveBeenCalledTimes(1);
    expect(queue.invalidateExecutionCheckpoints).toHaveBeenCalledWith(
      15,
      expect.stringContaining("checkpoint_invalidated_by_superseded")
    );
    expect(reviewIssueMock).not.toHaveBeenCalled();
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  it("respeita cancelamento cooperativo", async () => {
    queue.getJobState.mockResolvedValueOnce("cancelled");

    await processClaimedJob(
      makeJob({ id: 16, issueKey: "VAT-16", agentType: "analyst", triggerStatus: "Em Analise Tecnica", eventVersion: 11 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.markJobCancelled).toHaveBeenCalledTimes(1);
    expect(queue.invalidateExecutionCheckpoints).toHaveBeenCalledWith(
      16,
      expect.stringContaining("checkpoint_invalidated_by_cancelled")
    );
    expect(analyzeIssueMock).not.toHaveBeenCalled();
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  it("resume ativo com checkpoint ainda respeita stale antes de iniciar", async () => {
    process.env.RESUME_ENABLE_FUNCTIONAL = "1";
    process.env.REVIEWER_ENABLE_RESUME = "1";
    queue.isJobSuperseded.mockResolvedValueOnce(true);
    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 70,
      jobId: 17,
      issueKey: "VAT-17",
      agentType: "reviewer",
      checkpointVersion: 1,
      checkpointSeq: 3,
      state: {
        core: {
          turns: 3,
          inputTokens: 90,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          softBudgetMode: false,
          maxTokenRecoveries: 0,
          promptMode: "balanced",
        },
        context: { summary: "resume pronto" },
        toolProgress: [],
      },
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 17, issueKey: "VAT-17", eventVersion: 12 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.getLatestExecutionCheckpoint).toHaveBeenCalledWith(17);
    expect(queue.markJobStale).toHaveBeenCalledTimes(1);
    expect(reviewIssueMock).not.toHaveBeenCalled();
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  it("resume ativo com checkpoint ainda respeita cancelled antes de iniciar", async () => {
    process.env.RESUME_ENABLE_FUNCTIONAL = "1";
    process.env.ANALYST_ENABLE_RESUME = "1";
    queue.getJobState.mockResolvedValueOnce("cancelled");
    (queue.getLatestExecutionCheckpoint as any).mockResolvedValueOnce({
      id: 71,
      jobId: 18,
      issueKey: "VAT-18",
      agentType: "analyst",
      checkpointVersion: 1,
      checkpointSeq: 2,
      state: {
        core: {
          turns: 2,
          inputTokens: 40,
          outputTokens: 12,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          softBudgetMode: false,
          maxTokenRecoveries: 0,
          promptMode: "balanced",
        },
        context: { summary: "resume analise" },
        toolProgress: [],
      },
      isValid: true,
      invalidReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await processClaimedJob(
      makeJob({ id: 18, issueKey: "VAT-18", agentType: "analyst", triggerStatus: "Em Analise Tecnica", eventVersion: 13 }),
      baseConfig,
      queue,
      locks,
      () => 0
    );

    expect(queue.getLatestExecutionCheckpoint).toHaveBeenCalledWith(18);
    expect(queue.markJobCancelled).toHaveBeenCalledTimes(1);
    expect(analyzeIssueMock).not.toHaveBeenCalled();
    expect(queue.completeJob).not.toHaveBeenCalled();
  });
});
