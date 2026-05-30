# TODO Detalhado - 01 Config e Bootstrap

## Preparacao

- [x] Mapear variaveis obrigatorias atuais no codigo.
- [x] Mapear defaults de status no codigo e no .env.example.
- [x] Definir padrao unico para nomes de status.

## Implementacao

- [x] Criar src/bootstrap.ts com validacao de ambiente.
- [x] Implementar validacao de variaveis obrigatorias:
  - [x] ANTHROPIC_API_KEY
  - [x] JIRA_URL
  - [x] JIRA_USER_EMAIL
  - [x] JIRA_API_TOKEN
- [x] Implementar validacao de formato:
  - [x] URL valida para JIRA_URL
  - [x] numero valido para WEBHOOK_PORT
  - [x] numero valido para MYSQL_PORT quando definido
- [x] Alterar src/index.ts para executar bootstrap antes de iniciar servidor.
- [x] Padronizar defaults de status em src/index.ts.
- [x] Alinhar .env.example com os mesmos defaults.

## Scripts e documentacao

- [x] Revisar package.json para garantir fluxo de start/dev sem quebra.
- [x] Atualizar docs tecnicos com regras de bootstrap.
- [x] Atualizar README com erros comuns de configuracao.

## Validacao

- [x] Subir app com env completo e validar inicializacao.
- [x] Subir app sem ANTHROPIC_API_KEY e validar falha clara.
- [x] Subir app com JIRA_URL invalida e validar falha clara.

## Criterio de concluido

- [x] Nao inicia com ambiente invalido.
- [x] Mensagens de erro estao claras e agrupadas.
- [x] Defaults estao consistentes entre codigo e .env.example.
