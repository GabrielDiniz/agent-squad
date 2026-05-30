# 14 - Webhook para Enqueue e Dedupe

## Objetivo

Transformar webhook em produtor de jobs, removendo execução direta de agentes no request HTTP.

## Escopo

- Converter mudança de status em job enfileirado.
- Aplicar dedupe/idempotencia por evento.
- Preservar validações de assinatura e parse do payload.

## Entregáveis

1. Webhook que somente enfileira.
2. Função de mapeamento status -> agent_type.
3. Chave de idempotencia por evento.
4. Respostas HTTP consistentes com enqueue.

## Arquivos candidatos

- src/webhook.ts
- src/index.ts
- src/db.ts

## Critérios de aceite

1. Webhook não executa agente diretamente.
2. Evento duplicado não gera job duplicado.
3. Endpoint continua respondendo rápido com 202.

## Dependências

- Fase 13 concluída.

## Riscos

1. Dedupe mal definido descartar evento legítimo.

## Mitigações

1. Incluir version_token e validação de unicidade robusta.
