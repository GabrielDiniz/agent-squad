import http from "node:http";
import crypto from "node:crypto";
import { dbPing } from "./db.js";

type TriggerMap = Record<string, (issueKey: string) => Promise<void>>;

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
      let matchedHandler: ((issueKey: string) => Promise<void>) | undefined;

      for (const item of items) {
        const toStatus: string = item.toString ?? "";
        console.log(`[webhook] changelog item: field="${item.field}", from="${item.fromString}", to="${toStatus}"`);
        if (item.field === "status" && triggers[toStatus]) {
          matchedStatus = toStatus;
          matchedHandler = triggers[toStatus];
          break;
        }
      }

      if (matchedStatus && matchedHandler) {
        console.log(`[webhook] status "${matchedStatus}" detectado para issue ${payload.issue?.key}`);
        const issueKey: string | undefined = payload.issue?.key;
        if (issueKey) {
          res.writeHead(202).end();
          matchedHandler(issueKey).catch((err) =>
            console.error(`[webhook] ${issueKey} erro:`, err)
          );
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
