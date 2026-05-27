import http from "node:http";

type TriggerMap = Record<string, (issueKey: string) => Promise<void>>;

export function startWebhookServer(port: number, triggers: TriggerMap): http.Server {
  const triggerLabels = Object.keys(triggers).join(", ");

  const server = http.createServer((req, res) => {
    const path = ((req.url ?? "").split("?")[0] ?? "").replace(/\/$/, "");
    console.log(`[webhook] ${req.method} ${req.url}`);

    if (req.method !== "POST" || path !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
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
