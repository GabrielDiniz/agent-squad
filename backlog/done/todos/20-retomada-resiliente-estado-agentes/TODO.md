# TODO - Fase 20: Retomada Resiliente com Estado de Execucao dos Agentes

## Fechamento

- Data de fechamento: 2026-05-31
- Resultado: concluido
- Validacao final: typecheck e suite de testes verdes em container

## Checklist final

### 1) SLOs, limites e criterios de sucesso

- [x] Definir SLO de retomada: `resume_success_rate >= 95%` para retries elegiveis.
- [x] Definir meta de eficiencia: `token_saving_on_retry >= 60%`.
- [x] Definir meta de qualidade: `success_rate_resume >= success_rate_baseline - 1pp`.
- [x] Definir timeout maximo de rehydrate por agente.
- [x] Registrar baseline atual (sem resume) para comparativo.

### 2) Contrato e persistencia

- [x] `checkpoint_version` com politica de compatibilidade.
- [x] Estado retomavel minimo (`core`, `context`, `toolProgress`).
- [x] Criterio de invalidação por supersedencia/cancelamento.
- [x] Persistencia incremental por delta entre checkpoints.
- [x] Persistencia de hash de integridade e metadados de validade.
- [x] Leitura do ultimo checkpoint valido por job.
- [x] Limpeza/pruning de checkpoints antigos.

### 3) Worker e rehydrate

- [x] `load_checkpoint` antes da execucao do agente.
- [x] Fallback cold start para checkpoint invalido/incompatível/timeout.
- [x] Compatibilidade com locks, lease renewal e checkpoint cooperativo.
- [x] Comportamento correto para `stale` e `cancelled` durante resume.
- [x] Observabilidade com razoes de fallback e metricas de resume/save.

### 4) Agentes e replay

- [x] Helper compartilhado de serializacao de checkpoint.
- [x] Save incremental por turno nos 3 agentes.
- [x] Rehydrate nos 3 agentes preservando budget/prompt mode.
- [x] Whitelist de replay skip para tools read-only.
- [x] Bloqueio de replay skip para tools mutaveis/efeitos colaterais.
- [x] Idempotencia e consistencia de ordem de `tool_result` preservadas.

### 5) Testes e docs

- [x] Testes de serializacao/desserializacao e governanca de checkpoint.
- [x] Testes de worker para resume, fallback e compensacao.
- [x] Testes de stale/cancelled durante resume.
- [x] Testes de skip permitido vs bloqueado.
- [x] README e docs tecnicas atualizados com runbook, limites e go/no-go.
