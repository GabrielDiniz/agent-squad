# TODO - Fase 16: Locks de Issue e Codebase

## Objetivo operacional

Garantir execução isolada por issue e escrita serializada por codebase.

## Checklist detalhado

- [x] Implementar `acquireIssueLock` com lease e owner.
- [x] Implementar `acquireCodebaseLock` com lease e owner.
- [x] Implementar `renewLock` periódico para jobs longos.
- [x] Implementar `releaseLock` idempotente no fim do processamento.
- [x] Definir ordem fixa de aquisição/release para evitar deadlock.
- [x] Adicionar timeout e política de retry para lock indisponível.
- [x] Integrar lock de issue no início do processamento de job.
- [x] Integrar lock de codebase no trecho crítico de escrita/push.
- [x] Cobrir cenários de lock órfão e recuperação.

## Evidências esperadas

- Execuções concorrentes da mesma issue ficam serializadas.
- Colisões de escrita na mesma codebase deixam de ocorrer.

## Status

- Concluido em 2026-05-30.
- Evidencias:
	- src/db.ts
	- src/worker.ts
	- db/init.sql
	- db/migrate_queue_workers.sql
	- src/__tests__/worker.test.ts
