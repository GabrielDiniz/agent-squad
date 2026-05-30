# Backlog Executavel - Visao Geral

Este backlog detalha a implementacao das evolucoes recomendadas em etapas incrementais, com baixo risco de regressao e criterio de pronto claro.

## Objetivo

Executar as evolucoes tecnicas do projeto em fases curtas e revisaveis:

1. Padronizar status e bootstrap de ambiente.
2. Expor healthcheck.
3. Validar assinatura do webhook Jira.
4. Cobrir parser/conversor ADF com testes.
5. Implementar mapeamento dinamico de codebases.
6. Remover dependencia de edicao manual do docker-compose para novos codebases.

## Convencoes de execucao

- Cada etapa deve ser entregue em PR separado.
- Nao iniciar etapa N+1 sem criterios de aceite da N atendidos.
- Todo PR deve incluir:
  - Escopo do que mudou.
  - Evidencias de teste.
  - Riscos residuais.
  - Plano de rollback.

## Definicao de pronto global

- Build TypeScript sem erros.
- Fluxo de webhook funcional.
- Logs e metricas de sessao preservados.
- README e docs tecnicos atualizados conforme etapa.
- Sem quebra de compatibilidade do fluxo atual em modo padrao.

## Mapa de etapas

1. [Etapa 01 - Config e Bootstrap](01-etapa-config-bootstrap.md)
2. [Etapa 02 - Healthcheck](02-etapa-healthcheck.md)
3. [Etapa 03 - Seguranca de Webhook](03-etapa-assinatura-webhook.md)
4. [Etapa 04 - Testes ADF](04-etapa-testes-adf.md)
5. [Etapa 05 - Registry Dinamico de Codebases](05-etapa-registry-codebases.md)
6. [Etapa 06 - Operacao sem editar Compose](06-etapa-operacao-compose.md)

## Dependencias entre etapas

- Etapa 01 habilita guardrails de configuracao para todas as outras.
- Etapa 02 e 03 podem ocorrer em paralelo apos Etapa 01.
- Etapa 04 pode ser executada em paralelo com Etapa 02/03.
- Etapa 05 depende da Etapa 01 e deve preceder Etapa 06.
- Etapa 06 depende da Etapa 05 concluida.

## Riscos transversais

1. Divergencia de defaults entre codigo e .env.example.
2. Regressao no parser ADF por alteracao sem testes de snapshot/casos limite.
3. Descoberta dinamica mapear repositorios indevidos.
4. Fluxo de implementacao tocar em repositorio com estado local sensivel.

## Controle de rollout

- Introduzir feature flags para mudancas comportamentais.
- Publicar em modo hibrido antes de tornar padrao.
- Registrar metricas de erro antes e depois de cada etapa para comparacao.
