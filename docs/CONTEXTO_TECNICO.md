# Contexto Tecnico do Projeto

Este documento consolida o contexto completo para manutencao e evolucao do projeto.

## 1. Objetivo

O sistema executa um squad de agentes de IA orientado por mudancas de status no Jira.

Entrada:
- Evento de webhook Jira.

Saida:
- Comentarios e transicoes no Jira.
- Alteracoes de codigo (implementador), commit, push e PR/MR.
- Logs estruturados de sessao com tokens e custo no MySQL.

## 2. Arquitetura de alto nivel

Componentes principais:

1. Servidor webhook HTTP
- Arquivo: src/webhook.ts
- Endpoint: POST /webhook
- Detecta mudanca de status em payload.changelog.items
- Aciona handler mapeado por status

2. Orquestrador de entrada
- Arquivo: src/index.ts
- Carrega env, valida obrigatorias, roda migracao DB e registra triggers

3. Agentes
- src/agents/reviewer.ts
- src/agents/analyst.ts
- src/agents/implementor.ts

4. Integracao Jira REST
- Arquivo: src/jira.ts
- Leitura de issue, comentario, transicao, update de campo customizado
- Conversao Markdown -> ADF para escrita no Jira

5. Integracao Git/PR
- Arquivo: src/git.ts
- Parse de remotes e autenticacao por provedor
- Criacao de PR/MR em GitHub, GitLab e Bitbucket

6. Persistencia e custo
- src/db.ts para sessoes e migracao
- src/cost.ts para calculo em USD por modelo/tokens

7. Politica de retry/rate-limit
- src/retry.ts
- Retry progressivo para 429 e delay entre turnos com base em headers Anthropic

## 3. Fluxo do webhook

1. Jira envia POST para /webhook.
2. Servidor valida rota/metodo.
3. Faz parse do JSON.
4. Itera changelog.items e procura item.field == status.
5. Se status de destino existir no mapa de trigger:
   - responde 202 imediatamente
   - executa handler de forma assincrona
6. Se nao houver match, responde 200.

Observacao:
- O sistema considera o toString do status no changelog.

## 4. Mapeamento de status -> agente

Definido em src/index.ts.

Defaults:
- Revisor: JIRA_TRIGGER_STATUS ou Em Revisao
- Analista: JIRA_ANALYST_TRIGGER_STATUS ou Em Analise Tecnica
- Implementador: JIRA_IMPLEMENTOR_TRIGGER_STATUS ou Pronto para Comecar

## 5. Variaveis de ambiente

Obrigatorias na inicializacao:
- ANTHROPIC_API_KEY
- JIRA_URL
- JIRA_USER_EMAIL
- JIRA_API_TOKEN

Principais grupos:

1. Modelos
- CLAUDE_MODEL_REVIEWER
- CLAUDE_MODEL_ANALYST
- CLAUDE_MODEL_IMPLEMENTOR
- CLAUDE_MODEL (fallback global)

2. Jira e fluxo
- JIRA_TRIGGER_STATUS
- JIRA_APPROVED_STATUS
- JIRA_REJECTED_STATUS
- JIRA_ANALYST_TRIGGER_STATUS
- JIRA_ANALYST_DONE_STATUS
- JIRA_ANALYST_FIELD_ID
- JIRA_IMPLEMENTOR_TRIGGER_STATUS
- JIRA_IMPLEMENTOR_START_STATUS
- JIRA_IMPLEMENTOR_DONE_STATUS
- JIRA_IMPLEMENTOR_ERROR_STATUS

3. Git
- GIT_PROVIDER (github | gitlab | bitbucket)
- GH_TOKEN
- GITHUB_API_URL (opcional)
- GITLAB_TOKEN
- GITLAB_URL (opcional)
- BITBUCKET_APP_PASSWORD
- BITBUCKET_URL (opcional)
- GIT_USER_NAME
- GIT_USER_EMAIL

4. Execucao
- WEBHOOK_PORT
- CODEBASES_CONFIG
- AGENT_WORKDIR

5. Banco
- MYSQL_HOST
- MYSQL_PORT
- MYSQL_DATABASE
- MYSQL_USER
- MYSQL_PASSWORD
- MYSQL_ROOT_PASSWORD

6. Rate-limit
- RATELIMIT_TOKENS_THRESHOLD_PCT

## 6. Agentes em detalhe

### 6.1 Revisor

Arquivo: src/agents/reviewer.ts

Responsabilidades:
- Buscar issue no Jira
- Avaliar qualidade da historia por criterios e pesos
- Comentar aprovacao/reprovacao
- Transicionar status final

Caracteristicas tecnicas:
- Modelo default: claude-haiku-4-5-20251001
- Ferramentas internas: jira_get_issue, jira_add_comment, jira_transition_issue
- Limite de 10 turnos
- Persistencia parcial por turno (tokens/custo)

### 6.2 Analista

Arquivo: src/agents/analyst.ts

Responsabilidades:
- Ler demanda no Jira
- Explorar codebases/modulos relevantes
- Produzir proposta tecnica
- Gravar no campo customizado JIRA_ANALYST_FIELD_ID
- Transicionar para status de saida

Caracteristicas tecnicas:
- Modelo default: claude-sonnet-4-6
- Leitura controlada por comandos read-only
- Limite MAX_FILE_READS para cat/head/tail
- Limite de 25 turnos

Ferramentas:
- jira_get_issue
- list_codebases
- list_modules
- bash_read
- jira_update_field
- jira_transition_issue

### 6.3 Implementador

Arquivo: src/agents/implementor.ts

Responsabilidades:
- Ler issue e spec tecnica
- Criar branch
- Modificar arquivos (write_file/patch_file)
- Executar git/gh
- Publicar branch e abrir PR/MR
- Transicionar status final

Caracteristicas tecnicas:
- Modelo default: claude-sonnet-4-6
- Limite de 40 turnos
- Controle de leitura e escrita com validacoes de seguranca
- Sincroniza master local com origin/master antes de criar branch

Ferramentas:
- jira_get_issue
- list_codebases
- list_modules
- bash_read
- write_file
- patch_file
- bash_exec
- create_pull_request
- jira_transition_issue

Observacao importante:
- O metodo syncToMaster usa git checkout -f master e git reset --hard origin/master no codebase alvo antes da criacao de branch.

## 7. Persistencia de sessoes e custo

Arquivo: src/db.ts

Ciclo de vida:
1. dbInsertSession no inicio do agente
2. dbUpdateSession a cada turno
3. dbFinishSession no finally

Campos principais em api_sessions:
- prompt
- agent_type
- issue_key
- model
- codebase
- status
- num_turns
- total_cost_usd
- input_tokens
- output_tokens
- cache_read_tokens
- cache_creation_tokens
- created_at
- finished_at

Views:
- daily_costs
- monthly_costs
- issue_costs

Scripts SQL:
- db/init.sql cria tabela e views
- db/migrate_add_tokens.sql adiciona colunas/views de tokens em instalacoes existentes

## 8. Calculo de custo

Arquivo: src/cost.ts

Modelos precificados:
- claude-haiku-4-5-20251001
- claude-sonnet-4-6
- claude-opus-4-7

Formula:
- custo = (input * preco_input + cache_write * preco_cache_write + cache_read * preco_cache_read + output * preco_output) / 1_000_000

Se o modelo nao estiver mapeado:
- custo retorna 0 e loga warning.

## 9. Retry e rate-limit

Arquivo: src/retry.ts

withRateLimit:
- Retry ate 4 vezes para 429
- Espera incremental de 60s por tentativa

interTurnDelay:
- Le headers anthropic-ratelimit-*
- Espera por reset quando requests/tokens estao proximos do limite
- Delay minimo de 500ms

## 10. Jira: leitura e escrita ADF

Arquivo: src/jira.ts

Leitura:
- jiraGetIssue coleta summary, description, status, tipo, prioridade, labels, acceptance_criteria (customfield_10016) e technical_spec (campo configurado)
- adfToText transforma ADF em texto

Escrita:
- jiraAddComment usa markdownToAdf
- jiraUpdateIssueField usa markdownToAdf

markdownToAdf suporta:
- heading
- bold/italic/code inline
- links
- blockquote
- listas ordenadas e nao ordenadas
- code fence
- rule
- tabela basica

## 11. Git e PR/MR

Arquivo: src/git.ts

Pontos principais:
- parseRemoteUrl suporta SSH/HTTPS incluindo cenarios Bitbucket Server
- buildAuthenticatedUrl injeta credenciais para HTTPS conforme provedor
- createPullRequest abstrai GitHub/GitLab/Bitbucket

GitHub:
- Usa GH_TOKEN
- Suporta GITHUB_API_URL para enterprise

GitLab:
- Usa GITLAB_TOKEN
- Suporta GITLAB_URL para self-hosted

Bitbucket:
- Cloud: endpoint /2.0/repositories/.../pullrequests
- Server/DC: endpoint /rest/api/1.0/projects/.../repos/.../pull-requests
- Auth para git HTTPS prioriza BITBUCKET_APP_PASSWORD

## 12. Codebases configuraveis

Arquivo: codebases.json

Estrutura:
- codebases[] com name, path, description e modules[]

Uso:
- Analista e implementador consomem list_codebases/list_modules para orientar exploracao do repositorio-alvo.

Fallback:
- Se configuracao ausente/invalida, usa CODEBASE_PATH ou /workspace.

## 13. Infra e execucao

### 13.1 Sem Docker

Comandos:
- npm install
- npm run dev

### 13.2 Docker

Arquivos:
- Dockerfile multi-stage com estagios dev, builder e runtime
- docker-compose.yml com servico mysql e agent
- docker-compose.dev.yml para hot-reload

Detalhes relevantes:
- Runtime com usuario nao-root
- gh e uvx instalados na imagem
- known_hosts pre-populado para github/gitlab/bitbucket
- Volume externo de codebase montado em /workspace/versa-saude no compose atual

## 14. Endpoint e contrato de webhook

Endpoint:
- POST /webhook

Campos usados do payload:
- issue.key
- changelog.items[].field
- changelog.items[].toString

Comportamento de resposta:
- 404 para rota/metodo diferente
- 400 para JSON invalido
- 202 quando status disparador encontrado e handler iniciado
- 200 quando sem match de status

## 15. Riscos e pontos de atencao

1. Texto default de status
- Status padronizados no codigo e no .env.example; manter esse alinhamento em futuras alteracoes.

2. Operacoes destrutivas no codebase alvo
- Implementador sincroniza master com reset hard antes de abrir branch.
- Em ambientes compartilhados isso pode descartar alteracoes locais.

3. Dependencia de campos Jira
- acceptance_criteria usa customfield_10016 fixo.
- technical_spec depende de JIRA_ANALYST_FIELD_ID configurado.

4. Exposicao de contexto
- codebases.json atual contem descricao extensa de dominio e caminhos absolutos externos; revisar se isso deve estar versionado.

## 16. Evolucoes recomendadas

1. Evoluir politica de discovery dinamico com suporte a filtros por projeto/equipe.
2. Expandir testes para casos mais complexos de ADF (nested nodes e tabelas extensas).
3. Adicionar validacao de assinatura do webhook por provedor (caso use multiplos emissores).
4. Instrumentar metricas de healthcheck para monitoramento externo.
5. Criar cache persistente opcional para index de codebases descobertos.

## 17. Mapa de arquivos

Raiz:
- package.json: scripts e dependencias
- tsconfig.json: compilacao TS
- Dockerfile: build/dev/runtime
- docker-compose.yml: mysql + app
- docker-compose.dev.yml: override hot-reload
- codebases.json: catalogo de repositorios e modulos

Banco:
- db/init.sql
- db/migrate_add_tokens.sql

Aplicacao:
- src/index.ts
- src/webhook.ts
- src/jira.ts
- src/git.ts
- src/db.ts
- src/retry.ts
- src/cost.ts
- src/agents/reviewer.ts
- src/agents/analyst.ts
- src/agents/implementor.ts