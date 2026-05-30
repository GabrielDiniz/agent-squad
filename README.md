# Agent Squad

Orquestrador de agentes de IA para fluxo Jira -> análise -> implementação, com webhook HTTP e rastreamento de custo em MySQL.

## O que este projeto faz

- Escuta webhooks do Jira em /webhook.
- Exponibiliza healthcheck HTTP em /health.
- Pode validar assinatura HMAC do webhook antes de processar eventos.
- Dispara automaticamente um agente conforme a mudança de status do issue.
- Registra sessões, tokens e custo por execução no MySQL.
- Permite integração com GitHub, GitLab e Bitbucket para criação de PR/MR.
- Suporta cadastro URL-first de codebases e clone automático on-demand.

Para detalhes técnicos completos (arquitetura, fluxos internos, variáveis e decisões de implementação), veja:

- docs/CONTEXTO_TECNICO.md

## Fluxo funcional

1. Um issue muda de status no Jira.
2. O webhook recebe o evento, valida assinatura (quando habilitada) e identifica o status de destino.
3. O webhook enfileira job com idempotencia e retorna 202 rapidamente.
4. Workers (proximas fases) consumirao a fila para executar:
   - Revisor: avalia a história e aprova/reprova.
   - Analista: escreve solução técnica no campo customizado.
   - Implementador: altera código, comita, faz push e abre PR/MR.
5. O status do issue é atualizado no Jira conforme resultado da execucao do worker.

## Arquitetura alvo de fila e workers (planejada)

Evolucao definida no backlog ativo (fases 12 a 18):

1. O webhook deixa de executar agente diretamente e passa a somente enfileirar job (enqueue + 202).
2. Workers dedicados fazem claim transacional e processam jobs assincronamente.
3. Concorrencia passa a ser controlada por lock de issue e lock de codebase (em SQL).
4. Dedupe e idempotencia evitam jobs duplicados para o mesmo evento.
5. Supersedencia impede que eventos antigos sobrescrevam decisoes mais novas.
6. Contratos de backend serao abstratos para migracao futura de SQL para Redis.

Status atual:

- Webhook ja opera como produtor de jobs (enqueue-only).
- Worker SQL ja consome fila com claim transacional, heartbeat de lease e retry com backoff.
- Locks SQL por issue e codebase ativos no worker para serializacao e isolamento.
- Supersedencia por versao de evento e cancelamento cooperativo impedem regressao por jobs antigos.

Estados de job definidos na fase arquitetural:

- queued
- running
- done
- failed
- cancelled
- stale

Referencia tecnica completa:

- docs/CONTEXTO_TECNICO.md

## Pré-requisitos

- Node.js 20+ (recomendado 22).
- npm.
- Docker e Docker Compose (opcional, mas recomendado para ambiente completo).
- Chave da API Anthropic.
- Credenciais do Jira (URL, e-mail e token).

## Configuração rápida

1. Instale dependências:

```bash
npm install
```

2. Crie o arquivo de ambiente:

```bash
cp .env.example .env
```

3. Preencha no minimo no .env:

- ANTHROPIC_API_KEY
- JIRA_URL
- JIRA_USER_EMAIL
- JIRA_API_TOKEN

Variaveis importantes adicionais:

- CODEBASES_MODE=url
- CODEBASES_ROOT=/workspace/codebases
- CODEBASES_ALLOWED_HOSTS=github.com,gitlab.com,bitbucket.org
- CODEBASE_CLONE_RETRIES=1
- CODEBASE_CLONE_TIMEOUT_MS=300000
- WEBHOOK_SIGNATURE_REQUIRED=0
- JIRA_WEBHOOK_SIGNATURE_HEADER=x-hub-signature-256
- JIRA_WEBHOOK_SECRET=
- WORKER_ENABLED=1
- WORKER_CONCURRENCY=1
- WORKER_POLL_MS=1000
- WORKER_LEASE_MS=30000
- WORKER_RETRY_BASE_MS=2000
- WORKER_RETRY_MAX_MS=300000
- QUEUE_BACKEND=sql

Backends de fila/lock:

- `sql`: backend atual em producao.
- `redis`: reservado para migracao futura (flag ja existe, implementação pendente).

## Migracao SQL -> Redis (runbook resumido)

1. Implementar adapter Redis aderente ao contrato `QueueBackend` + `LockBackend`.
2. Rodar suíte de conformidade de backend e testes do worker sem alterar regras de negocio.
3. Ativar ambiente paralelo com `QUEUE_BACKEND=redis` em canario.
4. Comparar metricas de claim/retry/stale/cancelled entre SQL e Redis.
5. Executar cutover gradual por percentual de workers.
6. Em regressao, rollback imediato para `QUEUE_BACKEND=sql`.

## Rodando em desenvolvimento (local)

```bash
npm run dev
```

Servidor webhook:

- URL: http://localhost:3000/webhook
- Health: http://localhost:3000/health
- Porta alteravel via WEBHOOK_PORT

## Rodando com Docker Compose

Produção/local estável:

```bash
docker compose up --build
```

Desenvolvimento com hot reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Codebases sem editar compose por repositorio:

- O serviço usa um volume interno para cache de clones em /workspace/codebases.
- Para adicionar um novo projeto, basta cadastrar `repository_url` no `codebases.json`.
- Se a codebase não existir localmente, o agente faz clone automático antes de usar.

Mapeamento estatico com URL do repositorio:

- Em `codebases.json`, `repository_url` é obrigatório.
- Se `path` nao for informado, o sistema infere automaticamente usando o slug do repo dentro de `CODEBASES_ROOT`.
- Exemplo: `https://git.example.com/org/meu-projeto.git` -> `${CODEBASES_ROOT}/meu-projeto`.

## Scripts

- npm run dev: desenvolvimento com watch.
- npm run build: compila TypeScript para dist.
- npm start: executa build em produção.
- npm run typecheck: valida tipos sem gerar artefatos.
- npm test: executa testes unitarios.
- npm run test:watch: roda testes em modo watch.

## Banco de dados

Tabela principal:

- api_sessions: histórico de execução de agentes, tokens, custo e status.

Tabelas da fila/workers:

- queue_jobs: fila de processamento assíncrono com idempotência e retry.
- issue_work_state: estado mais recente por issue para controle de ordem/supersedência.
- codebase_locks: locks por codebase com lease para serializar escrita.

Views úteis:

- daily_costs
- monthly_costs
- issue_costs

Scripts SQL em db:

- db/init.sql
- db/migrate_add_tokens.sql
- db/migrate_queue_workers.sql

## Status que disparam agentes

Configuráveis via .env:

- JIRA_TRIGGER_STATUS: dispara revisor.
- JIRA_ANALYST_TRIGGER_STATUS: dispara analista.
- JIRA_IMPLEMENTOR_TRIGGER_STATUS: dispara implementador.

## Troubleshooting rápido

- Erro de variáveis ausentes ao iniciar:
   - confira ANTHROPIC_API_KEY, JIRA_URL, JIRA_USER_EMAIL e JIRA_API_TOKEN.
- Webhook não dispara:
   - valide se o Jira envia POST para /webhook e se houve mudança de status.
- Webhook retorna 401:
   - valide JIRA_WEBHOOK_SECRET e o header de assinatura configurado.
- Sem logs no MySQL:
   - confira MYSQL_HOST e credenciais no .env.
- Push/PR falhando:
   - revise token do provedor configurado em GIT_PROVIDER.

## Segurança

- Nunca comite .env.
- Use tokens com menor privilégio possível.
- Prefira injetar segredos por variáveis de ambiente no runtime.
