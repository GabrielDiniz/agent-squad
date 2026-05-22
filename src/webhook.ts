import http from "node:http";

const TRIGGER_STATUS = process.env.JIRA_TRIGGER_STATUS ?? "Em Revisão";

export function startWebhookServer(
  port: number,
  onTrigger: (issueKey: string) => Promise<void>
): http.Server {
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
      const statusChange = items.find(
        (i) => {
          console.log(`[webhook] changelog item: field="${i.field}", from="${i.fromString}", to="${i.toString}"`);
          return i.field === "status" && i.toString === TRIGGER_STATUS;
        }
      );

      if (statusChange) {
        console.log(`[webhook] status "${TRIGGER_STATUS}" detectado para issue ${payload.issue?.key}`);
        const issueKey: string | undefined = payload.issue?.key;
        if (issueKey) {
          res.writeHead(202).end();
          onTrigger(issueKey).catch((err) =>
            console.error(`[reviewer] ${issueKey} erro:`, err)
          );
          return;
        }
      }

      res.writeHead(200).end();
    });
  });

  server.listen(port, () =>
    console.log(
      `▶ webhook ouvindo em :${port}/webhook  (trigger: "${TRIGGER_STATUS}")`
    )
  );

  return server;
}
