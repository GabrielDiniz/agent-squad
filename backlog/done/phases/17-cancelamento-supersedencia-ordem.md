# 17 - Cancelamento, Supersedencia e Ordem

## Objetivo

Tratar mudanças de status durante execução, garantindo que jobs antigos não sobrescrevam decisão mais recente.

## Escopo

- Marcação de supersedência por issue/version.
- Cancelamento cooperativo no loop dos agentes.
- Skip de job stale quando status atual já divergiu.

## Entregáveis

1. Campo de versão/evento no job.
2. Regras de stale/cancelled/superseded.
3. Checkpoints de cancelamento entre turnos de agente.

## Arquivos candidatos

- src/worker.ts
- src/db.ts
- src/agents/reviewer.ts
- src/agents/analyst.ts
- src/agents/implementor.ts

## Critérios de aceite

1. Evento novo pode superseder execução em andamento sem corrupção de estado.
2. Job stale não aplica transição indevida.
3. Histórico de decisão por issue permanece auditável.

## Dependências

- Fase 15 concluída.
- Fase 16 concluída.

## Riscos

1. Cancelamento ocorrer em ponto não seguro de escrita.

## Mitigações

1. Definir checkpoints de cancelamento antes de seções críticas.
