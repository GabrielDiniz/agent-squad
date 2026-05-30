# 16 - Locks de Issue e Codebase

## Objetivo

Garantir isolamento de execução para evitar interferência entre jobs da mesma issue e colisão de escrita na mesma codebase.

## Escopo

- Lock por issue (exclusão mútua da mesma issue).
- Lock por codebase em seção crítica de escrita.
- Timeout, heartbeat e recuperação de lock órfão.

## Entregáveis

1. API de lock SQL (`acquire`, `renew`, `release`).
2. Uso do lock por issue antes da execução do agente.
3. Uso do lock por codebase no trecho crítico de git push/PR.

## Arquivos candidatos

- src/db.ts
- src/worker.ts
- src/agents/implementor.ts

## Critérios de aceite

1. Jobs da mesma issue não executam simultaneamente.
2. Escrita em mesma codebase não ocorre em paralelo.
3. Lock expirado é recuperável com segurança.

## Dependências

- Fase 15 concluída.

## Riscos

1. Deadlock e starvation sob alta concorrência.

## Mitigações

1. Ordem fixa de aquisição + timeout + backoff com jitter.
