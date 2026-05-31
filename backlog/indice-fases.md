# Indice de Fases do Backlog

Atualizado em: 2026-05-31

## Aguardando inicio

- Nenhuma fase pendente no ciclo atual.

## Em andamento

- Nenhuma fase em andamento no ciclo atual.

## Concluidas

1. [00 - Visao Geral](done/phases/00-visao-geral.md)
2. [01 - Config e Bootstrap](done/phases/01-etapa-config-bootstrap.md)
3. [02 - Healthcheck](done/phases/02-etapa-healthcheck.md)
4. [03 - Assinatura de Webhook](done/phases/03-etapa-assinatura-webhook.md)
5. [04 - Testes ADF](done/phases/04-etapa-testes-adf.md)
6. [05 - Registry Dinamico de Codebases](done/phases/05-etapa-registry-codebases.md)
7. [06 - Operacao sem editar Compose](done/phases/06-etapa-operacao-compose.md)
8. [07 - URL Only de Codebases](done/phases/07-url-only-codebases.md)
9. [08 - Repo Resolver e Clone](done/phases/08-repo-resolver-clone.md)
10. [09 - Agentes com Auto-Clone](done/phases/09-agentes-auto-clone.md)
11. [10 - Segurança e Credenciais Git](done/phases/10-seguranca-credenciais-git.md)
12. [11 - Migração Operacional e Rollout](done/phases/11-migracao-operacional-rollout.md)
13. [12 - Arquitetura de Fila e Contratos](done/phases/12-arquitetura-fila-contratos.md)
14. [13 - Schema SQL de Fila e Locks](done/phases/13-schema-sql-fila-locks.md)
15. [14 - Webhook para Enqueue e Dedupe](done/phases/14-webhook-enqueue-dedupe.md)
16. [15 - Worker de Execucao e Retry](done/phases/15-worker-execucao-retry.md)
17. [16 - Locks de Issue e Codebase](done/phases/16-locks-issue-codebase.md)
18. [17 - Cancelamento, Supersedencia e Ordem](done/phases/17-cancelamento-supersedencia-ordem.md)
19. [18 - Abstracao de Backend e Migracao para Redis](done/phases/18-abstracao-backend-migracao-redis.md)
20. [19 - Otimizacao de Tokens e Ciclos dos Agentes](done/phases/19-otimizacao-tokens-ciclos-agentes.md)
21. [20 - Retomada Resiliente com Estado de Execucao dos Agentes](done/phases/20-retomada-resiliente-estado-agentes.md)

## To-dos concluidos por fase

- [To-dos detalhados](done/todos)

## Como alimentar continuamente o backlog

1. Adicione um novo requisito em [backlog/inbox/README.md](inbox/README.md) usando o template.
2. Copie o modelo de fase em [backlog/templates/fase-template.md](templates/fase-template.md).
3. Crie os arquivos em [backlog/active/phases](active/phases) e [backlog/active/todos](active/todos).
4. Atualize este indice movendo a fase para "Em andamento".
5. Ao concluir, mova para [backlog/done/phases](done/phases) e [backlog/done/todos](done/todos).

## Iniciativa concluida 01

- Objetivo: remover dependência de volumes externos para codebase.
- Estratégia: descoberta por URL de repositório + clone automático antes da tarefa.
- Status: concluída.
- Tracking: fases 07 a 11 em [backlog/done/phases](done/phases) com TODOs em [backlog/done/todos](done/todos).

## Iniciativa concluida 02

- Objetivo: introduzir fila de trabalho com workers e locks transacionais para evitar interferencia entre agentes.
- Estratégia: fila e locks via tabelas SQL, com camada de abstração para migração futura para Redis.
- Status: concluída.
- Tracking: fases 12 a 18 em [backlog/done/phases](done/phases) com TODOs em [backlog/done/todos](done/todos).

## Iniciativa concluida 03

- Objetivo: reduzir consumo de tokens e ciclos por execução dos agentes, mantendo qualidade de saída e robustez operacional.
- Estratégia: prompt enxuto, modo tool-first, budget de tokens, sumarização incremental e cache por issue.
- Status: concluída.
- Tracking: fase 19 em [backlog/done/phases/19-otimizacao-tokens-ciclos-agentes.md](done/phases/19-otimizacao-tokens-ciclos-agentes.md) com TODO em [backlog/done/todos/19-otimizacao-tokens-ciclos-agentes/TODO.md](done/todos/19-otimizacao-tokens-ciclos-agentes/TODO.md).

## Iniciativa concluida 04

- Objetivo: habilitar retomada real de execucao apos falhas com checkpoint incremental de estado dos agentes.
- Estratégia: persistencia de estado retomavel minimo, rehydrate deterministico e replay com skip seguro de etapas elegiveis.
- Status: concluída.
- Tracking: fase 20 em [backlog/done/phases/20-retomada-resiliente-estado-agentes.md](done/phases/20-retomada-resiliente-estado-agentes.md) com TODO em [backlog/done/todos/20-retomada-resiliente-estado-agentes/TODO.md](done/todos/20-retomada-resiliente-estado-agentes/TODO.md).
