# Contexto Tecnico (Machine-Oriented)

Documento de referencia tecnica do Agent Squad para manutencao, operacao e evolucao.
Ordem de leitura: visao do sistema -> arquitetura -> contratos -> dados -> fluxos -> operacao.

## 1. Finalidade do sistema

O Agent Squad automatiza o ciclo Jira -> execucao de agentes -> atualizacao de saida tecnica/Git.

Principais objetivos:

- Transformar eventos de status do Jira em trabalho assíncrono rastreavel.
- Garantir processamento seguro em concorrencia (issue e codebase).
- Preservar consistencia quando eventos novos chegam durante execucao.
- Manter contratos estaveis para evoluir backend de persistencia.

## 2. Arquitetura em alto nivel

Pipeline principal:

`POST /webhook` -> enqueue de job -> claim por worker -> execucao do agente -> persistencia de resultado.

Caracteristicas arquiteturais:

- Webhook em modo enqueue-only.
- Worker dedicado para execucao assíncrona.
- Locks SQL com lease para coordenacao concorrente.
- Idempotencia e supersedencia para consistencia temporal.
- Abstracao de backend via `QueueBackend` e `LockBackend`.

## 3. Componentes e responsabilidades

### 3.1 Entrada HTTP

- Arquivo: `src/webhook.ts`
- Endpoints:
  - `POST /webhook`
  - `GET /health`
- Responsabilidades:
  - validar assinatura quando habilitada
  - parsear evento Jira
  - mapear status para `agent_type`
  - enfileirar job com idempotencia

### 3.2 Bootstrap e orquestracao de processo

- Arquivos: `src/index.ts`, `src/bootstrap.ts`
- Responsabilidades:
  - validar ambiente
  - executar migracoes
  - iniciar servidor webhook
  - iniciar worker

### 3.3 Worker runtime

- Arquivo: `src/worker.ts`
- Responsabilidades:
  - claim de job pronto
  - aquisicao, renovacao e liberacao de locks
  - checkpoints cooperativos
  - finalizacao (`done`, `failed`, `cancelled`, `stale`)

### 3.4 Agentes

- `src/agents/reviewer.ts`
- `src/agents/analyst.ts`
- `src/agents/implementor.ts`
- Todos aceitam checkpoint cooperativo durante o loop de execucao.

### 3.5 Persistencia

- Arquivo: `src/db.ts`
- Scripts SQL:
  - `db/init.sql`
  - `db/migrate_add_tokens.sql`
  - `db/migrate_queue_workers.sql`

### 3.6 Backend de fila e lock

- Contratos: `src/queue/backend.ts`
- Adapter SQL: `src/queue/sql-backend.ts`
- Factory: `getQueueLockBackend()`

## 4. Contratos de backend

### 4.1 QueueBackend

Arquivo: `src/queue/backend.ts`

Operacoes:

- `enqueueJob`
- `claimNextJob`
- `renewJobLease`
- `completeJob`
- `retryJob`
- `failJob`
- `getJobState`
- `isJobSuperseded`
- `markJobStale`
- `markJobCancelled`

### 4.2 LockBackend

Arquivo: `src/queue/backend.ts`

Operacoes:

- `acquireIssueLock`
- `renewIssueLock`
- `releaseIssueLock`
- `acquireCodebaseLock`
- `renewCodebaseLock`
- `releaseCodebaseLock`

### 4.3 Selecao de implementacao

- Variavel: `QUEUE_BACKEND`
- Valores aceitos:
  - `sql` (implementado)
  - `redis` (reservado)

## 5. Modelo de dados operacional

### 5.1 Filas e coordenacao

- `queue_jobs`
  - estados: `queued | running | done | failed | cancelled | stale`
  - idempotencia: unique em `idempotency_key`
  - lease: `worker_id`, `claimed_at`, `lease_until`

- `issue_work_state`
  - `latest_event_version`
  - `latest_job_id`
  - `current_state`
  - `current_agent_type`

- `issue_locks`
- `codebase_locks`

### 5.2 Observabilidade

- `api_sessions`
- views:
  - `daily_costs`
  - `monthly_costs`
  - `issue_costs`
  - `queue_jobs_overview`

## 6. Fluxo de processamento

### 6.1 Fluxo de webhook

1. Jira envia evento.
2. Webhook calcula `event_version` e `idempotency_key`.
3. Webhook enfileira job com `enqueueJob`.
4. Duplicata retorna dedupe sem novo trabalho executavel.
5. Evento novo pode marcar jobs antigos como `stale`.
6. Resposta HTTP: `202` com `jobId` e `deduped`.

### 6.2 Fluxo de worker

1. Worker faz claim (`claimNextJob`).
2. Aplica ordem fixa de locks:
   - `issue_lock`
   - `codebase_lock` (quando implementador)
3. Executa checkpoints cooperativos:
   - `before-run`
   - `between-turns`
   - `after-run`
4. Renova leases (job e locks) durante execucao.
5. Finaliza em `complete`, `retry`, `fail`, `stale` ou `cancelled`.
6. Libera locks na ordem inversa.

## 7. Invariantes de consistencia

1. Evento antigo nao pode sobrescrever estado mais novo da mesma issue.
2. Supersedencia e governada por `isJobSuperseded(issue, version)`.
3. Job em `cancelled` nao conclui como `done`.
4. Escrita concorrente na mesma codebase deve ser serializada.
5. Lock expirado pode ser recuperado com seguranca.

## 8. Modelo de erro e retry

- Falhas transitorias: timeout, rate-limit, rede, indisponibilidade momentanea.
- Falhas permanentes: contrato invalido, pre-condicao de dominio, erro nao recuperavel.
- Retry: backoff exponencial com jitter, limitado por `WORKER_RETRY_MAX_MS`.

## 9. Configuracao de ambiente

Obrigatorias:

- `ANTHROPIC_API_KEY`
- `JIRA_URL`
- `JIRA_USER_EMAIL`
- `JIRA_API_TOKEN`

Execucao e fila:

- `WEBHOOK_PORT`
- `WORKER_ENABLED`
- `WORKER_CONCURRENCY`
- `WORKER_POLL_MS`
- `WORKER_LEASE_MS`
- `WORKER_RETRY_BASE_MS`
- `WORKER_RETRY_MAX_MS`
- `QUEUE_BACKEND`

Provider Git:

- `GIT_PROVIDER=github|gitlab|bitbucket|azure`
- `GH_TOKEN` (GitHub)
- `GITLAB_TOKEN` (GitLab)
- `BITBUCKET_APP_PASSWORD` (Bitbucket)
- `AZURE_DEVOPS_PAT` (Azure DevOps)

Codebases:

- `CODEBASES_MODE=url`
- `CODEBASES_ROOT`
- `CODEBASES_ALLOWED_HOSTS`

Seguranca do webhook:

- `WEBHOOK_SIGNATURE_REQUIRED`
- `JIRA_WEBHOOK_SIGNATURE_HEADER`
- `JIRA_WEBHOOK_SECRET`

## 10. Operacao e verificacao

Checklist tecnico de operacao:

1. `GET /health` responde corretamente.
2. Worker habilitado e com conectividade ao MySQL.
3. Jobs transitam pelos estados esperados na `queue_jobs`.
4. Locks renovam e liberam sem orphan lock persistente.
5. Custos e sessoes registrados em `api_sessions` e views.

## 11. Evolucao de backend (SQL -> Redis)

Diretrizes de migracao:

1. Preservar semantica observavel de `QueueBackend` e `LockBackend`.
2. Manter regra de negocio fora do adapter de persistencia.
3. Validar conformidade via testes e regressao funcional.
4. Liberar com canario e rollback por `QUEUE_BACKEND=sql`.

## 12. Mapa de arquivos

- Entrada: `src/webhook.ts`
- Processo: `src/index.ts`, `src/bootstrap.ts`
- Worker: `src/worker.ts`
- Contratos/backend: `src/queue/backend.ts`, `src/queue/sql-backend.ts`
- Persistencia: `src/db.ts`
- Agentes: `src/agents/reviewer.ts`, `src/agents/analyst.ts`, `src/agents/implementor.ts`
- SQL: `db/init.sql`, `db/migrate_queue_workers.sql`, `db/migrate_add_tokens.sql`

## 13. Rollout e rollback da Fase 19

### 13.1 Feature flags por mecanismo

Cada agente possui quatro chaves de controle independentes:

- Prompt compacto: `*_ENABLE_PROMPT_COMPACT`
- Sumarização incremental: `*_ENABLE_SNAPSHOT`
- Cache por execução: `*_ENABLE_CACHE`
- Budget hard/soft: `*_ENABLE_BUDGET`

As flags permitem rollback granular por agente e por mecanismo sem alterar código.

### 13.2 Ordem de rollout

1. `reviewer` (menor risco operacional)
2. `analyst` (risco médio)
3. `implementor` (maior risco por escrita/Git/PR)

### 13.3 Critérios objetivos de rollback

Efetuar rollback se houver qualquer condição abaixo por janela de observação:

- taxa de sucesso cair mais de 5%
- latência média aumentar mais de 20%
- aumento de falhas de cadeia `tool_use`/`tool_result`
- interrupções por orçamento hard sem conclusão operacional aceitável

### 13.4 Procedimento de rollback

1. Desativar as flags no agente afetado (`*_ENABLE_* = 0`).
2. Reiniciar processo/containers para aplicar configuração.
3. Reenfileirar apenas issues impactadas.
4. Registrar evidências (logs, métricas, delta antes/depois) e ajustar limites.

## 14. Retomada resiliente (Fase 20)

### 14.1 Fluxo de resume (cold vs warm)

1. Worker tenta carregar último checkpoint válido por `job_id`.
2. Se checkpoint compatível com versão, injeta `resumeCheckpointState` no agente.
3. Se checkpoint ausente, incompatível ou erro de leitura, faz fallback para cold start.
4. Durante execução, agente salva checkpoints incrementais por turno e eventos críticos.
5. Worker emite telemetria consolidada (`load_hit`, `save_failed`, `resume_*`, `turns_skipped`, `tools_skipped`).

### 14.2 Contrato e governança de checkpoint

- `ExecutionCheckpointState` inclui `core`, `context` e `toolProgress`.
- Persistência aplica governança antes de gravar:
  - higienização de campos sensíveis (tokens/segredos/credenciais);
  - truncamento seguro de strings e payload;
  - remoção progressiva de `cachedResult` quando necessário;
  - pruning por `job_id` para manter apenas os N checkpoints mais recentes.
- Persistência usa envelope com metadados de validade:
  - `stateHash` (`sha256`) para integridade do estado;
  - `validity` com campos alterados e indicação de delta/full;
  - armazenamento em delta quando menor que snapshot full.
- Compatibilidade por versão:
  - `RESUME_CHECKPOINT_VERSION` define versão atual;
  - `RESUME_CHECKPOINT_MIN_COMPAT_VERSION` define faixa mínima aceita;
  - checkpoint incompatível é invalidado e execução segue em cold start.
- Em cancelamento/supersedencia cooperativa, checkpoints do job são invalidados.
- Rehydrate respeita timeout configurável (`RESUME_REHYDRATE_TIMEOUT_MS` e overrides por agente).

### 14.3 Quality gates por risco

- Flags:
  - `RESUME_ENABLE_QUALITY_GATES`
  - `*_ENABLE_QUALITY_GATES`
  - `*_QUALITY_GATE_RISK_THRESHOLD`
- Em risco alto, o agente exige evidência `QUALITY_GATE_OK:` antes de permitir transição terminal.
- Sem evidência, a transição final é bloqueada com mensagem corretiva (`QUALITY_GATE_REQUIRED`).

### 14.4 Runbook de incidentes

Checkpoint inválido/incompatível:

1. Verificar logs `version_mismatch` e `load_failed`.
2. Ajustar faixa de compatibilidade (`RESUME_CHECKPOINT_MIN_COMPAT_VERSION`) se aplicável.
3. Manter canário em cold start até estabilização.

Fallback frequente:

1. Monitorar `resume_fallback` por agente.
2. Validar integridade dos payloads e pruning.
3. Reduzir escopo do rollout para o último agente estável.

Falha recorrente de save:

1. Verificar conectividade/latência MySQL.
2. Inspecionar logs de governança (`truncated`, `redacted_fields`, `dropped_cached_results`).
3. Ajustar limites (`RESUME_CHECKPOINT_MAX_*`) e reavaliar.

### 14.5 Mitigação operacional de rollback de migração

- A migração de checkpoints é aditiva (tabela/índices novos).
- Rollback operacional padrão:
  1. desabilitar resume/replay/quality gates por flags;
  2. manter tabela para auditoria e limpeza posterior;
  3. executar limpeza controlada por janela de retenção;
  4. remover objetos SQL apenas em janela de manutenção dedicada.
