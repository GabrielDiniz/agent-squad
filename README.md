# Agent Squad

Agent Squad automatiza o fluxo entre Jira, agentes de IA e Git. O sistema recebe eventos de status do Jira, enfileira trabalhos, processa cada trabalho com isolamento e registra observabilidade operacional em MySQL.

Este documento foi escrito para pessoas: onboarding, operação e diagnóstico.
Para referência técnica detalhada de contratos e invariantes, use [docs/CONTEXTO_TECNICO.md](docs/CONTEXTO_TECNICO.md).

## 1. Visao geral

O projeto cobre quatro responsabilidades principais:

- Entrada HTTP por webhook do Jira.
- Orquestracao assíncrona por fila e workers.
- Execucao de agentes (`reviewer`, `analyst`, `implementor`).
- Integracao com provedores Git e persistencia operacional.

Em termos práticos, ele tira o trabalho manual de transicao entre análise, implementação e entrega técnica.

## 2. Como o fluxo funciona

1. Uma issue muda de status no Jira.
2. O webhook recebe o evento, valida assinatura (quando habilitada) e converte em job.
3. O job entra na fila com idempotencia para evitar duplicidade.
4. Um worker faz claim seguro do job e executa o agente correto.
5. Locks de issue e codebase evitam conflitos de concorrência.
6. O resultado do processamento e persistido com rastreabilidade.

Estados de job utilizados:

- `queued`
- `running`
- `done`
- `failed`
- `cancelled`
- `stale`

## 3. Pre-requisitos

- Node.js 20+ (recomendado 22)
- npm
- MySQL 8+
- Credenciais Jira
- Chave da API Anthropic

## 4. Primeira configuracao

1. Instale dependências:

```bash
npm install
```

2. Crie o arquivo de ambiente:

```bash
cp .env.example .env
```

3. Preencha variáveis obrigatórias:

- `ANTHROPIC_API_KEY`
- `JIRA_URL`
- `JIRA_USER_EMAIL`
- `JIRA_API_TOKEN`

4. Revise variáveis operacionais principais:

- `CODEBASES_MODE=url`
- `CODEBASES_ROOT=/workspace/codebases`
- `CODEBASES_ALLOWED_HOSTS=github.com,gitlab.com,bitbucket.org,dev.azure.com,ssh.dev.azure.com`
- `WEBHOOK_SIGNATURE_REQUIRED=0|1`
- `JIRA_WEBHOOK_SIGNATURE_HEADER=x-hub-signature-256`
- `JIRA_WEBHOOK_SECRET=`
- `WORKER_ENABLED=1`
- `WORKER_CONCURRENCY=1`
- `WORKER_POLL_MS=1000`
- `WORKER_LEASE_MS=30000`
- `WORKER_RETRY_BASE_MS=2000`
- `WORKER_RETRY_MAX_MS=300000`
- `QUEUE_BACKEND=sql`

5. Configure o provedor Git e credenciais:

- `GIT_PROVIDER=github|gitlab|bitbucket|azure`
- GitHub: `GH_TOKEN`
- GitLab: `GITLAB_TOKEN`
- Bitbucket: `BITBUCKET_APP_PASSWORD`
- Azure DevOps: `AZURE_DEVOPS_PAT`

## 5. Como executar

Desenvolvimento local:

```bash
npm run dev
```

Build e execução:

```bash
npm run build
npm start
```

Docker Compose padrão:

```bash
docker compose up --build
```

Docker Compose com hot reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

## 6. Endpoints e contratos externos

- `POST /webhook`: recebe eventos do Jira.
- `GET /health`: healthcheck de processo e dependências.

## 7. Banco de dados e observabilidade

Tabelas principais:

- `api_sessions`
- `queue_jobs`
- `issue_work_state`
- `issue_locks`
- `codebase_locks`

Views de acompanhamento:

- `daily_costs`
- `monthly_costs`
- `issue_costs`
- `queue_jobs_overview`

Scripts SQL utilizados:

- `db/init.sql`
- `db/migrate_add_tokens.sql`
- `db/migrate_queue_workers.sql`

## 8. Operacao diaria

Checklist rápido para operação:

1. Confirmar webhook ativo (`GET /health`).
2. Confirmar worker habilitado (`WORKER_ENABLED=1`).
3. Confirmar conectividade MySQL.
4. Confirmar credenciais de Git provider para push/PR.
5. Acompanhar filas e custos pelas tabelas/views.

## 9. Scripts uteis

- `npm run dev`
- `npm run build`
- `npm start`
- `npm run typecheck`
- `npm test`
- `npm run test:watch`

## 10. Troubleshooting

- Webhook retorna `401`:
  - validar `JIRA_WEBHOOK_SECRET` e `JIRA_WEBHOOK_SIGNATURE_HEADER`.
- Jobs não processam:
  - validar `WORKER_ENABLED=1`, conexão MySQL e leases/locks.
- Erro de backend:
  - usar `QUEUE_BACKEND=sql`.
- Falha de push/PR:
  - revisar `GIT_PROVIDER` e token do provedor configurado.

## 11. Backend de fila e lock

O runtime usa contratos de backend (`QueueBackend` e `LockBackend`) para desacoplar a regra de negócio da tecnologia de persistência.

- Backend disponível: `sql`.
- Valor reservado na flag: `redis`.

## 12. Onde aprofundar

- Especificação técnica completa: [docs/CONTEXTO_TECNICO.md](docs/CONTEXTO_TECNICO.md)
