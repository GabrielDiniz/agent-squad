# 20 - Retomada Resiliente com Estado de Execucao dos Agentes

## Objetivo

Implementar retomada real de execucao apos falhas/interrupcoes, com checkpoint incremental de estado dos agentes, minimizando custo de tokens no retry sem reduzir qualidade tecnica das entregas.

## Escopo

- Definir modelo de estado retomavel minimo para reviewer, analyst e implementor.
- Persistir checkpoints incrementais no banco com baixo overhead.
- Retomar execucao a partir do ultimo checkpoint valido em retries do worker.
- Evitar repeticao de chamadas de ferramenta ja concluídas quando ainda validas.
- Preservar consistencia operacional (locks, supersedencia, cancelamento, lease).
- Medir ganho real de custo/latencia e garantir ausencia de regressao funcional.
- Definir governanca de dados dos checkpoints (limite de payload, redacao de dados sensiveis e retencao).
- Garantir integridade transacional entre save de checkpoint e estado do job em cenarios de falha.
- Definir observabilidade de rollout com consultas/indicadores para decisao go/no-go.

## Entregas concluidas

1. Contrato de checkpoint versionado com compatibilidade e fallback.
2. Persistencia com governanca de payload, hash de integridade e metadados de validade.
3. Persistencia incremental por delta entre checkpoints quando vantajoso.
4. Invalidação automática de checkpoints em supersedencia, cancelamento, incompatibilidade e falha mid-run.
5. Rehydrate com timeout configurável por agente e fallback seguro.
6. Replay skip com whitelist read-only, bloqueio de tools mutáveis e chave determinística.
7. Quality gates por risco integrados aos três agentes.
8. Testes cobrindo resume, fallback, stale/cancelled com resume e replay policy.
9. Runbook e checklist operacional com SLOs, baseline e go/no-go.

## Criterios de aceite

1. Retry retoma a execucao do ultimo checkpoint valido em pelo menos 95% dos cenarios elegiveis.
2. Reducao de tokens por retry entre 60% e 85% nas execucoes retomadas.
3. Nao ha aumento da taxa de erro funcional por inconsistencias de contexto/tool chain.
4. Cancelamento/supersedencia continuam cooperativos e corretos durante retomada.
5. Locks e lease permanecem consistentes em execucoes retomadas.
6. Fallback para modo atual (sem retomada) funciona por flag sem downtime.
7. Politica de retencao/limpeza de checkpoints documentada e aplicada sem crescimento descontrolado.
8. Nenhum checkpoint persiste segredos/credenciais em texto livre.

## Status

- Concluida em 2026-05-31.
- Validacao final: `npm run typecheck` e `npm test` verdes em ambiente containerizado.
