const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "JIRA_URL",
  "JIRA_USER_EMAIL",
  "JIRA_API_TOKEN",
] as const;

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidPort(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

export function validateEnvironment(): string[] {
  const errors: string[] = [];

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    errors.push(`Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
  }

  const jiraUrl = process.env.JIRA_URL ?? "";
  if (jiraUrl && !isValidUrl(jiraUrl)) {
    errors.push("JIRA_URL invalida: use URL http(s) valida.");
  }

  const webhookPort = process.env.WEBHOOK_PORT;
  if (webhookPort && !isValidPort(webhookPort)) {
    errors.push("WEBHOOK_PORT invalida: use inteiro entre 1 e 65535.");
  }

  const mysqlPort = process.env.MYSQL_PORT;
  if (mysqlPort && !isValidPort(mysqlPort)) {
    errors.push("MYSQL_PORT invalida: use inteiro entre 1 e 65535.");
  }

  const signatureRequired = process.env.WEBHOOK_SIGNATURE_REQUIRED === "1";
  if (signatureRequired && !process.env.JIRA_WEBHOOK_SECRET) {
    errors.push("JIRA_WEBHOOK_SECRET obrigatoria quando WEBHOOK_SIGNATURE_REQUIRED=1.");
  }

  const mode = (process.env.CODEBASES_MODE ?? "url").toLowerCase();
  if (mode !== "url") {
    errors.push("CODEBASES_MODE invalido: use apenas 'url'.");
  }

  const codebasesRoot = process.env.CODEBASES_ROOT ?? "";
  if (!codebasesRoot.trim()) {
    errors.push("CODEBASES_ROOT obrigatoria para armazenamento local dos clones.");
  }

  const queueBackend = (process.env.QUEUE_BACKEND ?? "sql").toLowerCase();
  if (queueBackend !== "sql" && queueBackend !== "redis") {
    errors.push("QUEUE_BACKEND invalido: use 'sql' (atual) ou 'redis' (futuro).");
  }

  const gitProvider = (process.env.GIT_PROVIDER ?? "github").toLowerCase();
  if (!["github", "gitlab", "bitbucket", "azure"].includes(gitProvider)) {
    errors.push("GIT_PROVIDER invalido: use 'github', 'gitlab', 'bitbucket' ou 'azure'.");
  }

  return errors;
}

export function validateEnvironmentOrExit(): void {
  const errors = validateEnvironment();
  if (errors.length === 0) return;

  console.error("[bootstrap] Falha na validacao de ambiente:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
