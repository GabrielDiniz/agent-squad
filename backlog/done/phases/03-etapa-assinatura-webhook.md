# Etapa 03 - Validacao de Assinatura do Webhook Jira

## Objetivo

Aumentar seguranca do endpoint de webhook aceitando apenas requisicoes autenticadas por assinatura.

## Escopo

1. Definir segredo de webhook em ambiente.
2. Validar assinatura antes do parse/processamento do evento.
3. Rejeitar requests invalidas com status apropriado.

## Arquivos candidatos

- src/webhook.ts
- src/bootstrap.ts
- .env.example
- README.md
- docs/CONTEXTO_TECNICO.md

## Tarefas executaveis

1. Definir variavel de ambiente para segredo do webhook.
2. Identificar header de assinatura esperado do Jira (ou padrao adotado no projeto).
3. Implementar verificacao criptografica usando comparacao em tempo constante.
4. Em caso de falha:
   - retornar 401 ou 403
   - registrar log sem vazar segredo
5. Cobrir cenarios:
   - assinatura ausente
   - assinatura invalida
   - assinatura valida
6. Documentar configuracao no .env.example e README.

## Criterios de aceite

1. Requisicao sem assinatura valida nao dispara agente.
2. Requisicao valida continua funcionando normalmente.
3. Nenhum segredo sensivel aparece em logs.

## Testes

1. Payload com assinatura valida deve retornar 202/200 conforme trigger.
2. Payload com assinatura invalida deve retornar 401/403.
3. Regressao do fluxo atual de status deve permanecer.

## Riscos

1. Header incorreto bloquear eventos legitimos.
2. Diferencas de serializacao do corpo invalidarem hash.

## Mitigacoes

1. Logar motivo tecnico sem expor segredo.
2. Validar assinatura sobre raw body original.

## Evidencias esperadas no PR

1. Exemplo de validacao positiva e negativa.
2. Trecho de doc com configuracao do segredo.
3. Demonstracao de que agentes nao disparam em request invalida.

## Estimativa

- Esforco: medio.
- Risco: medio.
