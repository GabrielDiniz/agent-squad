import "dotenv/config";
import { setupSshKey, cleanupSshKey } from "./ssh-setup.js";
import { startWebhookServer } from "./webhook.js";
import { dbMigrate } from "./db.js";
import { validateEnvironmentOrExit } from "./bootstrap.js";
import { startWorkerFromEnv } from "./worker.js";

// Configura chave SSH (GIT_SSH_KEY_B64) antes de qualquer operação git.
// No-op se a variável não estiver definida.
setupSshKey();
process.on("exit", cleanupSshKey);
process.on("SIGINT", () => { cleanupSshKey(); process.exit(0); });
process.on("SIGTERM", () => { cleanupSshKey(); process.exit(0); });

const PORT = Number(process.env.WEBHOOK_PORT ?? 3000);

validateEnvironmentOrExit();

// Aplica migrações de schema antes de aceitar webhooks
dbMigrate().catch((err) => console.warn("[db] migration warning:", err));

const REVIEWER_TRIGGER = process.env.JIRA_TRIGGER_STATUS ?? "Em Revisão";
const ANALYST_TRIGGER = process.env.JIRA_ANALYST_TRIGGER_STATUS ?? "Em Análise Técnica";
const IMPLEMENTOR_TRIGGER = process.env.JIRA_IMPLEMENTOR_TRIGGER_STATUS ?? "Pronto para Começar";

startWebhookServer(PORT, {
  [REVIEWER_TRIGGER]: "reviewer",
  [ANALYST_TRIGGER]: "analyst",
  [IMPLEMENTOR_TRIGGER]: "implementor",
});

startWorkerFromEnv();
