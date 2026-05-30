# TODO - Fase 18: Abstracao de Backend e Migracao para Redis

## Objetivo operacional

Separar contrato de fila/locks do mecanismo de persistência e preparar migração gradual para Redis.

## Checklist detalhado

- [x] Definir interface `QueueBackend` (enqueue, claim, ack, fail, requeue).
- [x] Definir interface `LockBackend` (acquire, renew, release).
- [x] Criar implementação SQL das interfaces.
- [x] Refatorar worker para depender apenas das interfaces.
- [x] Criar feature flag de backend (`sql`, `redis` futuro).
- [x] Definir testes de conformidade para qualquer backend.
- [x] Documentar plano de migração sem downtime relevante.
- [x] Definir checklist operacional de cutover e rollback.

## Evidências esperadas

- Worker funcional com backend SQL via interface abstrata.
- Documento de migração com passos, riscos e rollback.

## Status

- Concluido em 2026-05-30.
- Evidencias:
	- src/queue/backend.ts
	- src/queue/sql-backend.ts
	- src/worker.ts
	- src/webhook.ts
	- src/bootstrap.ts
	- src/__tests__/worker.test.ts
