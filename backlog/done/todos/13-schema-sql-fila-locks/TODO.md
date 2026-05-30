# TODO - Fase 13: Schema SQL de Fila e Locks

## Objetivo operacional

Disponibilizar persistência transacional para fila, estado por issue e locks.

## Checklist detalhado

- [x] Criar tabela `queue_jobs` com colunas de estado, attempts, schedule e erro.
- [x] Criar tabela `issue_work_state` para estado corrente da issue/versionamento.
- [x] Criar tabela `codebase_locks` com owner, lease_until e heartbeat.
- [x] Definir constraints de unicidade para idempotencia de evento.
- [x] Criar índices para busca de jobs prontos por prioridade/next_run_at.
- [x] Criar índices para queries de lock e observabilidade.
- [x] Implementar migração SQL em arquivo dedicado.
- [x] Atualizar bootstrap/init para aplicar nova migração.

## Evidências esperadas

- Migração SQL aplicada sem erro em ambiente limpo.
- Query de claim demonstrando uso eficiente de índice.

## Status

- Concluido em 2026-05-30.
- Evidencias:
	- db/migrate_queue_workers.sql
	- db/init.sql
	- src/db.ts (dbMigrate)
