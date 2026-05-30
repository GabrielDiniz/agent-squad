# TODO - Fase 17: Cancelamento, Supersedencia e Ordem

## Objetivo operacional

Evitar que jobs antigos ou cancelados sobrescrevam estado mais recente da issue.

## Checklist detalhado

- [x] Definir mecanismo de versão/ordem do evento por issue.
- [x] Marcar jobs antigos como `stale` quando supersedidos.
- [x] Implementar cancelamento cooperativo durante execução.
- [x] Inserir checkpoints de cancelamento entre etapas do agente.
- [x] Proteger seção crítica contra cancelamento inseguro.
- [x] Persistir razão de cancelamento/supersedência para auditoria.
- [x] Ajustar transições para impedir atualização fora de ordem.
- [x] Cobrir testes de corrida entre evento novo e job em execução.

## Evidências esperadas

- Evento novo não sofre regressão por job antigo ainda rodando.
- Histórico evidencia por que um job foi cancelado/supersedido.

## Status

- Concluido em 2026-05-30.
- Evidencias:
	- src/db.ts
	- src/worker.ts
	- src/agents/reviewer.ts
	- src/agents/analyst.ts
	- src/agents/implementor.ts
	- src/__tests__/worker.test.ts
