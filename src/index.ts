import "dotenv/config";
import { startWebhookServer } from "./webhook.js";
import { reviewIssue } from "./agents/reviewer.js";
import { analyzeIssue } from "./agents/analyst.js";
import { implementIssue } from "./agents/implementor.js";
import { dbMigrate } from "./db.js";

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

// Aplica migrações de schema antes de aceitar webhooks
dbMigrate().catch((err) => console.warn("[db] migration warning:", err));

const REVIEWER_TRIGGER = process.env.JIRA_TRIGGER_STATUS ?? "Em Revisão";
const ANALYST_TRIGGER = process.env.JIRA_ANALYST_TRIGGER_STATUS ?? "Em Análise Técnica";
const IMPLEMENTOR_TRIGGER = process.env.JIRA_IMPLEMENTOR_TRIGGER_STATUS ?? "Pronto pra começar";

startWebhookServer(PORT, {
  [REVIEWER_TRIGGER]: reviewIssue,
  [ANALYST_TRIGGER]: analyzeIssue,
  [IMPLEMENTOR_TRIGGER]: implementIssue,
});
