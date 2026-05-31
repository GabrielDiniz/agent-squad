import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbPingMock = vi.fn(async () => true);
const enqueueJobMock = vi.fn();

vi.mock("../db.js", () => ({
  dbPing: dbPingMock,
}));

vi.mock("../queue/sql-backend.js", () => ({
  getQueueLockBackend: () => ({
    enqueueJob: enqueueJobMock,
  }),
}));

const { startWebhookServer } = await import("../webhook.js");

async function startServer(triggers: Record<string, "reviewer" | "analyst" | "implementor">): Promise<http.Server> {
  const server = startWebhookServer(0, triggers);
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
  }
  return server;
}

function postJson(port: number, body: unknown): Promise<{ status: number; rawBody: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/webhook",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, rawBody: raw });
        });
      }
    );

    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function samplePayload() {
  return {
    issue: { key: "VAT-123" },
    changelog: {
      id: "98765",
      items: [{ field: "status", fromString: "Backlog", toString: "Em Revisão" }],
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  process.env.WEBHOOK_SIGNATURE_REQUIRED = "0";
  process.env.JIRA_WEBHOOK_SECRET = "";
  process.env.JIRA_WEBHOOK_SIGNATURE_HEADER = "x-hub-signature";
});

describe("webhook enqueue", () => {
  it("retorna 202 e enfileira job para status mapeado", async () => {
    enqueueJobMock.mockResolvedValueOnce({ jobId: 11, deduped: false });

    const server = await startServer({ "Em Revisão": "reviewer" });
    const port = (server.address() as any).port as number;

    try {
      const res = await postJson(port, samplePayload());
      const body = JSON.parse(res.rawBody);

      expect(res.status).toBe(202);
      expect(body.accepted).toBe(true);
      expect(body.jobId).toBe(11);
      expect(body.deduped).toBe(false);
      expect(enqueueJobMock).toHaveBeenCalledTimes(1);
      const firstCall = enqueueJobMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall?.[0]).toMatchObject({
        issueKey: "VAT-123",
        agentType: "reviewer",
        triggerStatus: "Em Revisão",
        eventVersion: 98765,
      });
    } finally {
      server.close();
    }
  });

  it("dedupe retorna mesmo endpoint 202 sem duplicar semanticamente", async () => {
    enqueueJobMock
      .mockResolvedValueOnce({ jobId: 11, deduped: false })
      .mockResolvedValueOnce({ jobId: 11, deduped: true });

    const server = await startServer({ "Em Revisão": "reviewer" });
    const port = (server.address() as any).port as number;

    try {
      const first = await postJson(port, samplePayload());
      const second = await postJson(port, samplePayload());

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(JSON.parse(first.rawBody).deduped).toBe(false);
      expect(JSON.parse(second.rawBody).deduped).toBe(true);
      expect(enqueueJobMock).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
    }
  });
});
