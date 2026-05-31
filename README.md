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

## 8.1 Rollout da otimização de tokens (Fase 19)

Feature flags por agente (todas em `.env`):

- `*_ENABLE_PROMPT_COMPACT`
- `*_PROMPT_MODE=auto|compact|balanced|deep`
- `*_PROMPT_AUTO_COOLDOWN_TURNS`
- `*_PROMPT_AUTO_MIN_TURNS_FOR_DEEP`
- `*_PROMPT_AUTO_DEEP_COMPLEXITY_THRESHOLD`
- `*_PROMPT_AUTO_DEEP_BUDGET_CEILING`
- `*_PROMPT_AUTO_COMPACT_BUDGET_THRESHOLD`
- `*_PROMPT_AUTO_MAX_SWITCHES`
- `*_ENABLE_SNAPSHOT`
- `*_ENABLE_CACHE`
- `*_ENABLE_BUDGET`
- `RESUME_ENABLE_CHECKPOINT_SAVE`
- `RESUME_ENABLE_CHECKPOINT_LOAD`
- `RESUME_CHECKPOINT_VERSION`
- `RESUME_ENABLE_FUNCTIONAL`
- `REVIEWER_ENABLE_RESUME`
- `ANALYST_ENABLE_RESUME`
- `IMPLEMENTOR_ENABLE_RESUME`
- `RESUME_ENABLE_REPLAY_SKIP`
- `REVIEWER_ENABLE_REPLAY_SKIP`
- `ANALYST_ENABLE_REPLAY_SKIP`
- `IMPLEMENTOR_ENABLE_REPLAY_SKIP`
- `REVIEWER_REPLAY_MAX_CACHED_RESULT_CHARS`
- `ANALYST_REPLAY_MAX_CACHED_RESULT_CHARS`
- `IMPLEMENTOR_REPLAY_MAX_CACHED_RESULT_CHARS`
- `RESUME_ENABLE_QUALITY_GATES`
- `REVIEWER_ENABLE_QUALITY_GATES`
- `ANALYST_ENABLE_QUALITY_GATES`
- `IMPLEMENTOR_ENABLE_QUALITY_GATES`
- `REVIEWER_QUALITY_GATE_RISK_THRESHOLD`
- `ANALYST_QUALITY_GATE_RISK_THRESHOLD`
- `IMPLEMENTOR_QUALITY_GATE_RISK_THRESHOLD`
- `RESUME_CHECKPOINT_MIN_COMPAT_VERSION`
- `RESUME_CHECKPOINT_MAX_PER_JOB`
- `RESUME_CHECKPOINT_MAX_STATE_CHARS`
- `RESUME_CHECKPOINT_MAX_STRING_CHARS`
- `RESUME_CHECKPOINT_MAX_TOOL_PROGRESS`
- `RESUME_CHECKPOINT_REDACT_SENSITIVE`
- `RESUME_REHYDRATE_TIMEOUT_MS`
- `REVIEWER_REHYDRATE_TIMEOUT_MS`
- `ANALYST_REHYDRATE_TIMEOUT_MS`
- `IMPLEMENTOR_REHYDRATE_TIMEOUT_MS`

Uso recomendado de `*_PROMPT_MODE`:

- `auto`: padrão recomendado para produção (seleção dinâmica por contexto + pressão de orçamento).
- `compact`: menor custo, instruções enxutas para demandas simples/repetitivas.
- `balanced`: fixo, equilíbrio entre custo e qualidade.
- `deep`: melhor cobertura para demandas complexas (mais validações e planejamento técnico).

Regras do modo `auto`:

- promove para `deep` quando a complexidade contextual aumenta e o orçamento ainda está folgado;
- reduz para `compact` ao entrar em pressão de orçamento (soft/hard) para preservar continuidade;
- aplica cooldown/histerese para evitar troca excessiva de modo no meio da execução.

Regras para retomada funcional por checkpoint:

- mantenha `RESUME_ENABLE_FUNCTIONAL=0` até validar o modo passivo (save/load) em produção controlada;
- habilite primeiro `REVIEWER_ENABLE_RESUME=1` (canário de menor risco);
- depois avance para `ANALYST_ENABLE_RESUME=1` e por fim `IMPLEMENTOR_ENABLE_RESUME=1`, apenas após estabilizar métricas de sucesso e custo na etapa anterior.

Regras para replay skip (canário):

- manter `RESUME_ENABLE_REPLAY_SKIP=0` no início;
- habilitar primeiro `REVIEWER_ENABLE_REPLAY_SKIP=1` junto com resume funcional do reviewer;
- habilitar depois `ANALYST_ENABLE_REPLAY_SKIP=1` e por fim `IMPLEMENTOR_ENABLE_REPLAY_SKIP=1` com janela de observação por etapa;
- usar `*_REPLAY_MAX_CACHED_RESULT_CHARS` para limitar payload reaproveitado e controlar custo/memória.

Ordem recomendada de rollout:

1. `reviewer`
2. `analyst`
3. `implementor`

Procedimento por etapa:

1. Ativar flags apenas do agente alvo.
2. Executar por janela curta (ex.: 10-20 issues) e comparar métricas.
3. Validar: taxa de sucesso, latência média, custo por issue e taxa de `max_tokens`.
4. Avançar para o próximo agente somente se não houver degradação relevante.

Critérios de rollback imediato:

- queda de taxa de sucesso > 5%
- aumento de latência média > 20%
- aumento de erros de tool chain (`tool_use`/`tool_result` inconsistente)
- aumento de interrupções por orçamento hard sem conclusão operacional

Passos de rollback:

1. Desativar no agente afetado: `*_ENABLE_PROMPT_COMPACT=0`, `*_ENABLE_SNAPSHOT=0`, `*_ENABLE_CACHE=0`, `*_ENABLE_BUDGET=0`.
2. Reiniciar serviço/containers.
3. Reprocessar apenas issues impactadas.
4. Registrar incidente com causa e ajuste de limites.

## 8.2 Runbook da retomada resiliente (Fase 20)

### Ativação em canário

1. Habilitar save/load (`RESUME_ENABLE_CHECKPOINT_SAVE=1`, `RESUME_ENABLE_CHECKPOINT_LOAD=1`).
2. Manter `RESUME_ENABLE_FUNCTIONAL=0` e validar telemetria de checkpoint passivo.
3. Habilitar resume funcional por ordem: `reviewer` -> `analyst` -> `implementor`.
4. Habilitar replay skip por ordem idêntica após estabilização de cada etapa.
5. Habilitar quality gates apenas para o agente em canário quando necessário.

### Queries operacionais (canário)

Taxa de `load_hit` e fallback por agente (via logs):

- filtrar linhas `checkpoint-metrics` e agregar `load_hit`, `resume_fallback`, `version_mismatch` por `agent`.

Falha de save de checkpoint:

```sql
SELECT issue_key, agent_type, COUNT(*) AS total_invalid
FROM agent_execution_checkpoints
WHERE is_valid = 0
GROUP BY issue_key, agent_type
ORDER BY total_invalid DESC;
```

Variação de tokens em retry (before/after):

```sql
SELECT
  issue_key,
  agent_type,
  attempts,
  AVG(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS avg_tokens
FROM api_sessions
WHERE created_at >= NOW() - INTERVAL 7 DAY
GROUP BY issue_key, agent_type, attempts
ORDER BY issue_key, agent_type, attempts;
```

Baseline de qualidade (resume vs sem resume):

```sql
SELECT
  agent_type,
  CASE WHEN attempts > 1 THEN 'retry' ELSE 'first_try' END AS attempt_group,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
  COUNT(*) AS total,
  ROUND(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 4) AS success_rate
FROM api_sessions
WHERE created_at >= NOW() - INTERVAL 14 DAY
GROUP BY agent_type, attempt_group
ORDER BY agent_type, attempt_group;
```

### Alertas mínimos

- `resume_fallback` acima de 20% na janela do canário.
- `save_failed` > 0 de forma contínua na janela.
- `version_mismatch` inesperado após deploy estável.
- bloqueios repetidos de quality gate sem conclusão (`QUALITY_GATE_REQUIRED`).
- `load_failed` com padrão de timeout (`rehydrate_timeout_ms_*`) acima do limiar da etapa.

### SLOs e limites operacionais da fase

- `resume_success_rate >= 95%` para retries elegíveis.
- `token_saving_on_retry >= 60%` (meta canário).
- `success_rate_resume >= success_rate_baseline - 1pp`.
- timeout de rehydrate por agente controlado por `*_REHYDRATE_TIMEOUT_MS`.

### Rollback imediato

1. Desativar `*_ENABLE_REPLAY_SKIP` e `*_ENABLE_RESUME` do agente afetado.
2. Se necessário, desativar `RESUME_ENABLE_FUNCTIONAL` global.
3. Manter save/load passivo ativo para diagnóstico.
4. Se houver incompatibilidade de versão, ajustar `RESUME_CHECKPOINT_MIN_COMPAT_VERSION` e reavaliar.

### Go/No-Go

- Go: sem regressão funcional, fallback controlado, sem crescimento descontrolado de checkpoint e ganho de tokens em retry.
- No-Go: aumento sustentado de erro, latência ou fallback sem causa corrigível na janela.

### Tabela consolidada (ganhos e riscos residuais)

| Dimensão | Indicador | Meta / Faixa | Evidência operacional | Risco residual |
|---|---|---|---|---|
| Retomada | `resume_success_rate` | >= 95% (retries elegíveis) | Logs `checkpoint-metrics` (`resume_success`, `resume_fallback`) | Médio (dependente da qualidade do checkpoint) |
| Eficiência | Redução de tokens em retry | 60% a 85% | Comparativo por `api_sessions` (`attempts`, `avg_tokens`) | Médio-baixo |
| Estabilidade | `save_failed` de checkpoint | Tendência próxima de 0 | Logs de save + alertas de canário | Médio (DB intermitente) |
| Consistência | Ordem de `checkpoint_seq` | Sem regressão de sequência | Rejeição de save fora de ordem + teste unitário | Baixo |
| Segurança | Segredos em checkpoint | 0 exposição textual | Governança com redaction/truncamento | Baixo |
| Compatibilidade | Versão de checkpoint | faixa `min_compat..current` | `version_mismatch` + invalidação/fallback cold start | Médio |
| Qualidade técnica | Gate em risco alto | Transição final só com `QUALITY_GATE_OK` | Bloqueio `QUALITY_GATE_REQUIRED` em runtime | Médio-baixo |

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
