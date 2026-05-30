# TODO Detalhado - 03 Assinatura de Webhook

## Preparacao

- [x] Confirmar header e algoritmo de assinatura que sera adotado.
- [x] Definir nome da variavel de segredo no ambiente.

## Implementacao

- [x] Capturar raw body antes de parsear JSON.
- [x] Implementar calculo de assinatura esperado.
- [x] Implementar comparacao em tempo constante.
- [x] Rejeitar requisicoes invalidas com status apropriado.
- [x] Garantir logs sem exposicao de segredo ou hash sensivel.

## Configuracao

- [x] Adicionar segredo no .env.example com placeholder.
- [x] Incluir validacao do segredo no bootstrap quando assinatura estiver habilitada.

## Documentacao

- [x] Atualizar README com configuracao da assinatura.
- [x] Atualizar docs tecnicos com fluxo de validacao.

## Validacao

- [x] Requisicao sem assinatura deve ser rejeitada.
- [x] Requisicao com assinatura invalida deve ser rejeitada.
- [x] Requisicao com assinatura valida deve processar normalmente.

## Criterio de concluido

- [x] Webhook nao aceita origem nao autenticada.
- [x] Fluxo legitimo permanece funcional.
