# Etapa 01 - Padronizacao de Configuracao e Bootstrap

## Objetivo

Eliminar inconsistencias de configuracao e falhar rapido com mensagens claras antes da inicializacao do servidor.

## Escopo

1. Padronizar nomes e defaults de status em codigo e ambiente.
2. Criar script de bootstrap para validacao de variaveis criticas.
3. Integrar bootstrap ao fluxo de start/dev.

## Arquivos candidatos

- src/index.ts
- .env.example
- package.json
- src/bootstrap.ts (novo)
- docs/CONTEXTO_TECNICO.md
- README.md

## Tarefas executaveis

1. Levantar matriz de status atuais e defaults por local de definicao.
2. Definir fonte unica de verdade para nomes default.
3. Ajustar defaults em src/index.ts para ficar identico ao .env.example.
4. Criar modulo bootstrap com validacoes:
   - variaveis obrigatorias
   - formato minimo de URL (JIRA_URL)
   - numericos quando aplicavel (WEBHOOK_PORT, MYSQL_PORT)
5. Exibir erros agrupados por categoria e encerrar com exit code 1.
6. Chamar bootstrap no inicio da execucao.
7. Atualizar scripts npm, se necessario, para manter experiencia de dev.
8. Atualizar documentacao operacional.

## Criterios de aceite

1. Aplicacao nao inicia sem variaveis obrigatorias.
2. Mensagem de erro lista todas as variaveis faltantes de uma vez.
3. Defaults de status estao iguais em codigo e .env.example.
4. Fluxo existente continua funcionando com .env valido.

## Testes

1. Inicializacao com .env completo: deve subir normalmente.
2. Inicializacao sem ANTHROPIC_API_KEY: deve falhar com mensagem objetiva.
3. Inicializacao com URL invalida: deve falhar no bootstrap.
4. Verificacao manual de consistencia entre codigo e .env.example.

## Riscos

1. Endurecimento excessivo bloquear ambientes legacy.
2. Diferenca de maiusculas/minusculas em nomes de status.

## Mitigacoes

1. Tornar validacoes de formato estritas somente no necessario.
2. Documentar claramente exemplos validos no .env.example.

## Evidencias esperadas no PR

1. Log de falha controlada sem stacktrace ruidosa.
2. Captura de execucao com ambiente valido.
3. Diff da padronizacao de status.

## Estimativa

- Esforco: pequeno para medio.
- Risco: baixo.
