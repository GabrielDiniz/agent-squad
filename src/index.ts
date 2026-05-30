import "dotenv/config";
import { startWebhookServer } from "./webhook.js";
import { reviewIssue } from "./agents/reviewer.js";
import { analyzeIssue } from "./agents/analyst.js";
import { implementIssue } from "./agents/implementor.js";
import { dbMigrate } from "./db.js";
import { validateEnvironmentOrExit } from "./bootstrap.js";

const PORT = Number(process.env.WEBHOOK_PORT ?? 3000);

validateEnvironmentOrExit();

// Aplica migrações de schema antes de aceitar webhooks
dbMigrate().catch((err) => console.warn("[db] migration warning:", err));

const REVIEWER_TRIGGER = process.env.JIRA_TRIGGER_STATUS ?? "Em Revisão";
const ANALYST_TRIGGER = process.env.JIRA_ANALYST_TRIGGER_STATUS ?? "Em Análise Técnica";
const IMPLEMENTOR_TRIGGER = process.env.JIRA_IMPLEMENTOR_TRIGGER_STATUS ?? "Pronto para Começar";

startWebhookServer(PORT, {
  [REVIEWER_TRIGGER]: reviewIssue,
  [ANALYST_TRIGGER]: analyzeIssue,
  [IMPLEMENTOR_TRIGGER]: implementIssue,
});
