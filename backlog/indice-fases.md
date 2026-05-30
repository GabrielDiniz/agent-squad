# Indice de Fases do Backlog

Atualizado em: 2026-05-30

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

## To-dos concluidos por fase

- [To-dos detalhados](done/todos)

## Como alimentar continuamente o backlog

1. Adicione um novo requisito em [backlog/inbox/README.md](inbox/README.md) usando o template.
2. Copie o modelo de fase em [backlog/templates/fase-template.md](templates/fase-template.md).
3. Crie os arquivos em [backlog/active/phases](active/phases) e [backlog/active/todos](active/todos).
4. Atualize este indice movendo a fase para "Em andamento".
5. Ao concluir, mova para [backlog/done/phases](done/phases) e [backlog/done/todos](done/todos).

## Iniciativa ativa

- Objetivo: remover dependência de volumes externos para codebase.
- Estratégia: descoberta por URL de repositório + clone automático antes da tarefa.
- Status: concluída.
- Tracking: fases 07 a 11 em [backlog/done/phases](done/phases) com TODOs em [backlog/done/todos](done/todos).

## Nova iniciativa

- Objetivo: introduzir fila de trabalho com workers e locks transacionais para evitar interferencia entre agentes.
- Estratégia: fila e locks via tabelas SQL, com camada de abstração para migração futura para Redis.
- Status: concluída.
- Tracking: fases 12 a 18 em [backlog/done/phases](done/phases) com TODOs em [backlog/done/todos](done/todos).
