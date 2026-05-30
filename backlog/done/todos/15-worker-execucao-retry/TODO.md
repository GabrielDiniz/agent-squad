# TODO - Fase 15: Worker de Execucao e Retry

## Objetivo operacional

Implementar worker robusto com claim seguro, execução, retry e finalização consistente.

## Checklist detalhado

- [x] Criar loop de worker com polling e paralelismo configurável.
- [x] Implementar claim atômico (transação) para evitar dupla execução.
- [x] Registrar `started_at`, `worker_id` e heartbeat durante processamento.
- [x] Encadear execução do agente conforme tipo de job.
- [x] Implementar `completeJob` com persistência de saída/resumo.
- [x] Implementar `failJob` com classificação de erro.
- [x] Implementar retry com backoff exponencial e jitter.
- [x] Implementar limite de tentativas e dead-letter lógico.
- [x] Cobrir com testes de concorrência mínima e retry.

## Evidências esperadas

- Dois workers simultâneos não processam o mesmo job.
- Erro transitório produz requeue com `next_run_at` futuro.

## Status

- Concluido em 2026-05-30.
- Evidencias:
	- src/worker.ts
	- src/db.ts
	- src/index.ts
	- src/__tests__/worker.test.ts
