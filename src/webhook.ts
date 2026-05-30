import http from "node:http";
import crypto from "node:crypto";
import { dbPing, type AgentType } from "./db.js";
import type { QueueBackend } from "./queue/backend.js";
import { getQueueLockBackend } from "./queue/sql-backend.js";

type TriggerMap = Record<string, AgentType>;

function buildEventVersion(payload: any): number {
  const changelogId = payload?.changelog?.id;
  if (changelogId !== undefined) {
    const n = Number(changelogId);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }

  const created = payload?.timestamp ?? payload?.changelog?.created;
  if (typeof created === "number" && Number.isFinite(created) && created >= 0) {
    return Math.floor(created);
  }
  if (typeof created === "string" && created.trim()) {
    const ms = Date.parse(created);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }

  return Date.now();
}

function buildIdempotencyKey(issueKey: string, toStatus: string, eventVersion: number, agentType: AgentType): string {
  const raw = `${issueKey}|${toStatus}|${eventVersion}|${agentType}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function enqueueJobFromWebhook(params: {
  payload: any;
  issueKey: string;
  matchedStatus: string;
  matchedAgentType: AgentType;
  queue: QueueBackend;
}): Promise<{ jobId: number; deduped: boolean }> {
  const { payload, issueKey, matchedStatus, matchedAgentType, queue } = params;
  const eventVersion = buildEventVersion(payload);
  const idempotencyKey = buildIdempotencyKey(issueKey, matchedStatus, eventVersion, matchedAgentType);

  return queue.enqueueJob({
    issueKey,
    agentType: matchedAgentType,
    triggerStatus: matchedStatus,
    eventVersion,
    idempotencyKey,
    payload,
  });
}

function getHeader(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function signatureLooksValid(rawBody: string, secret: string, received: string | null): boolean {
  if (!received) return false;

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const accepted = received.startsWith("sha256=") ? received.slice(7) : received;

  const actual = Buffer.from(accepted, "utf-8");
  const expected = Buffer.from(digest, "utf-8");
  if (actual.length !== expected.length) return false;

  return crypto.timingSafeEqual(actual, expected);
}

export function startWebhookServer(port: number, triggers: TriggerMap): http.Server {
  const triggerLabels = Object.keys(triggers).join(", ");
  const startedAt = Date.now();

  const signatureRequired = process.env.WEBHOOK_SIGNATURE_REQUIRED === "1";
  const signatureSecret = process.env.JIRA_WEBHOOK_SECRET ?? "";
  const signatureHeader = (process.env.JIRA_WEBHOOK_SIGNATURE_HEADER ?? "x-hub-signature-256").toLowerCase();
  const mustValidateSignature = signatureRequired || Boolean(signatureSecret);

  const queue = getQueueLockBackend();

  const server = http.createServer((req, res) => {
    const path = ((req.url ?? "").split("?")[0] ?? "").replace(/\/$/, "");
    console.log(`[webhook] ${req.method} ${req.url}`);

    if (req.method === "GET" && path === "/health") {
      void (async () => {
        const dbOk = await dbPing();
        const body = {
          status: dbOk ? "ok" : "degraded",
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
          checks: { db: dbOk ? "ok" : "error" },
        };
        const statusCode = dbOk ? 200 : 503;
        res.writeHead(statusCode, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      })();
      return;
    }

    if (req.method !== "POST" || path !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (mustValidateSignature) {
        const provided = getHeader(req, signatureHeader);
        const valid = signatureLooksValid(body, signatureSecret, provided);
        if (!valid) {
          console.warn("[webhook] assinatura invalida");
          res.writeHead(401).end("invalid signature");
          return;
        }
      }

      let payload: any;
      try {
        payload = JSON.parse(body);
        console.log(`[webhook] payload recebido para issue ${payload.issue?.key}`);
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }

      const items: any[] = payload.changelog?.items ?? [];
      let matchedStatus: string | undefined;
      let matchedAgentType: AgentType | undefined;

      for (const item of items) {
        const toStatus: string = item.toString ?? "";
        console.log(`[webhook] changelog item: field="${item.field}", from="${item.fromString}", to="${toStatus}"`);
        if (item.field === "status" && triggers[toStatus]) {
          matchedStatus = toStatus;
          matchedAgentType = triggers[toStatus];
          break;
        }
      }

      if (matchedStatus && matchedAgentType) {
        console.log(`[webhook] status "${matchedStatus}" detectado para issue ${payload.issue?.key}`);
        const issueKey: string | undefined = payload.issue?.key;
        if (issueKey) {
          void (async () => {
            try {
              const { jobId, deduped } = await enqueueJobFromWebhook({
                payload,
                issueKey,
                matchedStatus,
                matchedAgentType,
                queue,
              });

              console.log(
                `[webhook] enqueue issue=${issueKey} status=${matchedStatus} agent=${matchedAgentType} jobId=${jobId} deduped=${deduped}`
              );

              res
                .writeHead(202, { "Content-Type": "application/json" })
                .end(
                  JSON.stringify({
                    accepted: true,
                    issueKey,
                    status: matchedStatus,
                    agentType: matchedAgentType,
                    jobId,
                    deduped,
                  })
                );
            } catch (err) {
              console.error("[webhook] erro ao enfileirar job:", err);
              res.writeHead(503).end("queue unavailable");
            }
          })();
          return;
        }
      }

      res.writeHead(200).end();
    });
  });

  server.listen(port, () =>
    console.log(`▶ webhook ouvindo em :${port}/webhook  (triggers: "${triggerLabels}")`)
  );

  return server;
}
