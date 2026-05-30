# TODO Detalhado - 02 Healthcheck

## Preparacao

- [x] Definir contrato da resposta de healthcheck.
- [x] Escolher se readiness vai incluir check de DB nesta etapa.

## Implementacao

- [x] Implementar rota GET /health no servidor HTTP.
- [x] Retornar JSON com:
  - [x] status
  - [x] uptime
  - [x] timestamp
- [x] Opcional: incluir check de DB com timeout curto.
- [x] Garantir que POST /webhook permanece com comportamento atual.

## Infra

- [x] Adicionar healthcheck no servico agent do docker-compose.
- [x] Revisar porta e endpoint usados no healthcheck.

## Documentacao

- [x] Atualizar README com endpoint de health.
- [x] Atualizar docs tecnicos com semantica de liveness/readiness.

## Validacao

- [x] Curl em /health retorna 200 com payload esperado.
- [x] Webhook continua aceitando POST normalmente.
- [x] Container sinaliza healthy no compose.

## Criterio de concluido

- [x] Endpoint de health ativo e estavel.
- [x] Sem regressao no fluxo de webhook.
