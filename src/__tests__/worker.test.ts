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
    expect(analyzeIssueMock).not.toHaveBeenCalled();
    expect(queue.completeJob).not.toHaveBeenCalled();
  });
});
