# TODO - Fase 12: Arquitetura de Fila e Contratos

## Objetivo operacional

Produzir base arquitetural e contrato funcional para implementação segura das fases seguintes.

## Checklist detalhado

- [x] Mapear fluxo atual webhook -> agente e identificar pontos síncronos que viram enqueue.
- [x] Definir tipo de job (payload mínimo, metadados, issue, status, timestamps).
- [x] Definir máquina de estados de job com transições permitidas.
- [x] Definir invariantes (um job running por issue, lock exclusivo de codebase no trecho crítico etc.).
- [x] Definir chave de idempotencia de evento e janela de dedupe.
- [x] Definir semântica de supersedência por ordem de eventos/status.
- [x] Descrever contrato de erro transitório vs permanente.
- [x] Publicar decisões no contexto técnico.

## Evidências esperadas

- Documento atualizado em docs com diagrama textual de estados.
- Lista de invariantes usada como referência nas implementações.

## Status

- Concluido em 2026-05-30.
- Evidencia principal: docs/CONTEXTO_TECNICO.md (secoes 3.1 a 3.7).
