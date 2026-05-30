# 18 - Abstracao de Backend e Migracao para Redis

## Objetivo

Introduzir interfaces de fila e lock independentes de storage, com implementação SQL inicial e contrato compatível com Redis.

## Escopo

- Interface `QueueBackend` e `LockBackend`.
- Adapter SQL como implementação padrão.
- Documento de estratégia de migração para Redis sem ruptura.

## Entregáveis

1. Contratos TypeScript de backend.
2. Implementação SQL conectada ao worker.
3. Feature flag para seleção de backend futuro.
4. Runbook de migração SQL -> Redis.

## Arquivos candidatos

- src/queue/backend.ts (novo)
- src/queue/sql-backend.ts (novo)
- src/bootstrap.ts
- docs/CONTEXTO_TECNICO.md
- README.md

## Critérios de aceite

1. Worker usa interfaces, não SQL direto.
2. Com backend SQL, comportamento permanece estável.
3. Critérios de compatibilidade com Redis estão documentados.

## Dependências

- Fase 15 concluída.
- Fase 16 concluída.
- Fase 17 concluída.

## Riscos

1. Abstração fraca vazar detalhes SQL e dificultar migração.

## Mitigações

1. Definir contrato por comportamento e testes de conformidade.
