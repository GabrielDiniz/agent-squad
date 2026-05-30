# 15 - Worker de Execucao e Retry

## Objetivo

Implementar worker que consome jobs com claim seguro, executa agente e registra resultado.

## Escopo

- Claim transacional de jobs.
- Execução por worker_id com heartbeat.
- Ciclo completo (`running` -> `done`/`failed`).
- Retry com backoff e limite de tentativas.

## Entregáveis

1. Módulo de worker loop com polling configurável.
2. Claim atômico com concorrência segura.
3. Funções de complete/fail/requeue.
4. Controle de attempts e next_run_at.

## Arquivos candidatos

- src/worker.ts (novo)
- src/index.ts
- src/db.ts

## Critérios de aceite

1. Dois workers não processam o mesmo job.
2. Falhas transitórias são reprocessadas com backoff.
3. Job excedendo limite vai para estado final de erro.

## Dependências

- Fase 13 concluída.
- Fase 14 concluída.

## Riscos

1. Loop de retry infinito por erro não transitório.

## Mitigações

1. Classificação de erro + limite de tentativas + dead-letter lógico.
