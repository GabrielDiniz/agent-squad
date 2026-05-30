# 13 - Schema SQL de Fila e Locks

## Objetivo

Criar estrutura de banco para suportar fila de jobs, estado por issue e locks por codebase/issue.

## Escopo

- Tabela de jobs.
- Tabela de estado por issue.
- Tabela de locks (ou mecanismo equivalente em SQL).
- Índices para claim eficiente e dedupe.

## Entregáveis

1. Script de migração SQL para queue_jobs.
2. Script de migração SQL para issue_work_state.
3. Script de migração SQL para codebase_locks.
4. Views operacionais de observabilidade da fila.

## Arquivos candidatos

- db/migrate_queue_workers.sql (novo)
- db/init.sql
- src/db.ts

## Critérios de aceite

1. Inserção de job com chave idempotente funciona.
2. Claim concorrente não duplica execução.
3. Lock por codebase e issue persiste estado e timeout.

## Dependências

- Fase 12 concluída.

## Riscos

1. Índices inadequados degradarem throughput.

## Mitigações

1. Revisar plano de execução e índices por consulta crítica.
