import "dotenv/config";
import { startWebhookServer } from "./webhook.js";
import { reviewIssue } from "./reviewer.js";

const PORT = Number(process.env.WEBHOOK_PORT ?? 3000);

const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "JIRA_URL",
  "JIRA_USER_EMAIL",
  "JIRA_API_TOKEN",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("✗ variáveis obrigatórias ausentes:", missing.join(", "));
  process.exit(1);
}

startWebhookServer(PORT, reviewIssue);
