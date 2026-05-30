# TODO Detalhado - 00 Visao Geral

## Objetivo operacional

Traduzir a visao geral em sequencia executavel e governanca de entrega.

## To-do list

- [x] Validar a ordem das etapas com o time tecnico e produto.
- [x] Definir dono principal e backup para cada etapa.
- [x] Definir SLA de review por PR.
- [x] Definir janela de deploy por etapa.
- [x] Definir estrategia de rollback por etapa.
- [x] Definir metrica baseline antes das mudancas:
  - [x] taxa de erros no webhook
  - [x] tempo medio de execucao dos agentes
  - [x] taxa de falha de transicao Jira
- [x] Definir template unico de PR para todas as etapas.
- [x] Definir template unico de issue interna para rastreio.
- [x] Configurar board com colunas:
  - [x] Ready
  - [x] In Progress
  - [x] In Review
  - [x] QA
  - [x] Done
- [x] Publicar criterios globais de pronto no README de backlog.

## Checkpoint de qualidade

- [x] Todas as etapas possuem dono.
- [x] Todas as etapas possuem criterio de aceite testavel.
- [x] Todas as etapas possuem plano de rollback.
