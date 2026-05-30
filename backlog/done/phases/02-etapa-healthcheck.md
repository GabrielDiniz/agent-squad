# Etapa 02 - Healthcheck HTTP

## Objetivo

Expor endpoint simples para liveness/readiness e facilitar monitoramento do servico.

## Escopo

1. Adicionar endpoint GET /health.
2. Incluir verificacoes minimas de prontidao.
3. Ajustar compose para healthcheck quando aplicavel.

## Arquivos candidatos

- src/webhook.ts
- src/index.ts
- docker-compose.yml
- docs/CONTEXTO_TECNICO.md
- README.md

## Tarefas executaveis

1. Definir contrato de resposta JSON do healthcheck:
   - status
   - uptime
   - timestamp
   - checks (db opcional)
2. Implementar rota GET /health.
3. Retornar 200 quando servico responsivo.
4. Opcional: check de conectividade DB com timeout curto.
5. Adicionar healthcheck no servico agent no compose.
6. Atualizar documentacao de observabilidade.

## Criterios de aceite

1. GET /health responde 200 com JSON consistente.
2. Endpoint nao interfere no fluxo POST /webhook.
3. Compose consegue usar healthcheck para status do container.

## Testes

1. Curl local no endpoint apos subir app.
2. Validar comportamento com e sem MYSQL_HOST configurado.
3. Testar rota webhook apos incluir health endpoint.

## Riscos

1. Check de DB lento degradar endpoint.
2. Mudanca na camada HTTP introduzir regressao de roteamento.

## Mitigacoes

1. Timeouts curtos e fallback para status degradado.
2. Cobrir casos de metodo e path com testes manuais.

## Evidencias esperadas no PR

1. Resposta de exemplo de /health.
2. Logs de subida e estado saudavel.
3. Compose com healthcheck funcional.

## Estimativa

- Esforco: pequeno.
- Risco: baixo.
