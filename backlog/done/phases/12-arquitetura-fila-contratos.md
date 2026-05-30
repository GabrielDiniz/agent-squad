# 12 - Arquitetura de Fila e Contratos

## Objetivo

Definir arquitetura alvo da orquestracao assíncrona com fila de jobs, workers e contratos de estado por issue.

## Escopo

- Definir fronteira entre webhook e worker.
- Definir contrato de job e estados de ciclo de vida.
- Definir estratégia de idempotencia e versionamento de eventos.

## Entregáveis

1. Documento de arquitetura da fila.
2. Contrato de estados do job (`queued`, `running`, `done`, `failed`, `cancelled`, `stale`).
3. Regras de transição e invariantes.
4. Matriz de concorrência (issue, codebase, worker).

## Arquivos candidatos

- docs/CONTEXTO_TECNICO.md
- README.md
- backlog/active/todos/12-arquitetura-fila-contratos/TODO.md

## Critérios de aceite

1. Arquitetura define claramente responsabilidades de webhook, fila e worker.
2. Estados e transições estão formalizados.
3. Estratégia de idempotencia e supersedencia está explícita.

## Dependências

- Nenhuma.

## Riscos

1. Ambiguidade de regras gerar comportamento divergente na implementação.

## Mitigações

1. Definir invariantes obrigatórias e exemplos de casos limite.
