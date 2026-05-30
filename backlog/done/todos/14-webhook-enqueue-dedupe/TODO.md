# TODO - Fase 14: Webhook para Enqueue e Dedupe

## Objetivo operacional

Converter endpoint de webhook em produtor de jobs, mantendo segurança e baixa latência.

## Checklist detalhado

- [x] Extrair função `enqueueJobFromWebhook` com validações explícitas.
- [x] Mapear status Jira para tipo de agente sem executar agente no request.
- [x] Gerar chave idempotente por evento/status/issue.
- [x] Inserir job em `queue_jobs` com upsert/ignore seguro para duplicados.
- [x] Responder `202 Accepted` com payload mínimo de rastreio.
- [x] Preservar validação de assinatura e rejeição de payload inválido.
- [x] Incluir logs estruturados de enqueue (sem segredos).
- [x] Cobrir com testes de dedupe e retorno HTTP.

## Evidências esperadas

- Requisições duplicadas não geram múltiplos jobs executáveis.
- P95 do webhook reduzido por remoção de execução síncrona do agente.

## Status

- Concluido em 2026-05-30.
- Evidencias:
	- src/webhook.ts
	- src/db.ts
	- src/index.ts
	- src/__tests__/webhook-enqueue.test.ts
