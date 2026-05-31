# 19 - Otimizacao de Tokens e Ciclos dos Agentes

## Objetivo

Reduzir custo, latência e consumo de contexto dos agentes (reviewer, analyst, implementor), mantendo qualidade funcional e previsibilidade operacional.

## Escopo

- Otimizar prompts e comportamento de ferramentas para reduzir saída desnecessária.
- Introduzir controles de orçamento de tokens e recuperação inteligente de fluxo.
- Reduzir reprocessamento de contexto via sumarização incremental e cache de consultas.
- Definir métricas operacionais para acompanhar custo por issue e estabilidade por execução.

## Entregáveis

1. Política de orçamento de tokens por execução e por agente.
2. Estratégia de prompt enxuto por fase (discovery, execução, publicação).
3. Modo tool-first para reduzir respostas textuais longas.
4. Estratégia de sumarização incremental para compactar histórico longo.
5. Cache local por issue para consultas repetitivas (Jira e módulos/codebases).
6. Ajuste de limites de saída de leitura e resposta dos agentes.
7. Telemetria mínima de eficiência (tokens/turno, ciclos, taxa de recuperação, taxa de sucesso).
8. Plano de rollout progressivo com fallback seguro.

## Arquivos candidatos

- src/agents/reviewer.ts
- src/agents/analyst.ts
- src/agents/implementor.ts
- src/retry.ts
- src/bootstrap.ts
- src/db.ts
- src/__tests__/worker.test.ts
- src/__tests__/webhook-enqueue.test.ts
- README.md
- docs/CONTEXTO_TECNICO.md
- .env.example

## Criterios de aceite

1. Redução mensurável de tokens por issue sem queda de taxa de conclusão.
2. Redução de ocorrências de `stop_reason=max_tokens` em analyst e implementor.
3. Nenhum aumento de falhas por inconsistência de histórico/tool_use.
4. Comportamento de fallback preserva auditabilidade (logs + comentários Jira quando aplicável).
5. Estratégia de otimização é controlável por variáveis de ambiente (enable/disable).

## Dependências

- Fase 15 concluída (worker e execução por fila).
- Fase 16 concluída (locks e proteção concorrente).
- Fase 17 concluída (cancelamento/supersedência).
- Fase 18 concluída (abstração de backend).

## Riscos

1. Prompt excessivamente enxuto reduzir qualidade técnica das decisões.
2. Sumarização agressiva remover contexto crítico e causar regressão funcional.
3. Cache por issue servir dado obsoleto em cenários de atualização concorrente.
4. Budget de tokens muito restritivo causar ciclos extras e aumentar latência.

## Mitigacoes

1. Rollout progressivo por feature flags e comparação A/B por agente.
2. Limites conservadores iniciais com ajuste gradual por métrica real.
3. Invalidar cache quando houver mudança de status/changelog relevante.
4. Manter fallback para modo atual (full-context) em caso de degradação.

## Evidencias no PR

1. Logs comparativos antes/depois (tokens, turnos, custo estimado, tempo).
2. Tabela de métricas por agente com variação percentual.
3. Prints/trechos de execução comprovando modo tool-first e recuperação estável.
4. Documentação de flags e runbook de rollback.

## Estimativa

- Esforco: medio-alto (refatoracao de loops dos agentes + telemetria + rollout).
- Risco: medio (impacta núcleo de decisão e consumo de contexto).
