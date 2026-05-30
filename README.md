# Agent Squad

Orquestrador de agentes de IA para fluxo Jira -> análise -> implementação, com webhook HTTP e rastreamento de custo em MySQL.

## O que este projeto faz

- Escuta webhooks do Jira em /webhook.
- Exponibiliza healthcheck HTTP em /health.
- Pode validar assinatura HMAC do webhook antes de processar eventos.
- Dispara automaticamente um agente conforme a mudança de status do issue.
- Registra sessões, tokens e custo por execução no MySQL.
- Permite integração com GitHub, GitLab e Bitbucket para criação de PR/MR.
- Suporta mapeamento dinâmico de codebases (static, discover, hybrid).

Para detalhes técnicos completos (arquitetura, fluxos internos, variáveis e decisões de implementação), veja:

- docs/CONTEXTO_TECNICO.md

## Fluxo funcional

1. Um issue muda de status no Jira.
2. O webhook recebe o evento e identifica o status de destino.
3. O agente correspondente executa:
    - Revisor: avalia a história e aprova/reprova.
    - Analista: escreve solução técnica no campo customizado.
    - Implementador: altera código, comita, faz push e abre PR/MR.
4. O status do issue é atualizado no Jira conforme resultado.

## Pré-requisitos

- Node.js 20+ (recomendado 22).
- npm.
- Docker e Docker Compose (opcional, mas recomendado para ambiente completo).
- Chave da API Anthropic.
- Credenciais do Jira (URL, e-mail e token).

## Configuração rápida

1. Instale dependências:

```bash
npm install
```

2. Crie o arquivo de ambiente:

```bash
cp .env.example .env
```

3. Preencha no minimo no .env:

- ANTHROPIC_API_KEY
- JIRA_URL
- JIRA_USER_EMAIL
- JIRA_API_TOKEN

Variaveis importantes adicionais:

- CODEBASES_MODE=hybrid
- CODEBASES_ROOT=/workspace/codebases
- WEBHOOK_SIGNATURE_REQUIRED=0
- JIRA_WEBHOOK_SIGNATURE_HEADER=x-hub-signature-256
- JIRA_WEBHOOK_SECRET=

## Rodando em desenvolvimento (local)

```bash
npm run dev
```

Servidor webhook:

- URL: http://localhost:3000/webhook
- Health: http://localhost:3000/health
- Porta alteravel via WEBHOOK_PORT

## Rodando com Docker Compose

Produção/local estável:

```bash
docker compose up --build
```

Desenvolvimento com hot reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Codebases sem editar compose por repositorio:

- Monte uma raiz unica em CODEBASES_ROOT_HOST (padrao /workspaces).
- Adicione novos repositorios dentro dessa raiz.
- O sistema descobre automaticamente no modo discover/hybrid.

Mapeamento estatico com URL do repositorio:

- Em `codebases.json`, voce pode informar `repository_url` para facilitar cadastro.
- Se `path` nao for informado, o sistema infere automaticamente usando o slug do repo dentro de `CODEBASES_ROOT`.
- Exemplo: `https://git.example.com/org/meu-projeto.git` -> `${CODEBASES_ROOT}/meu-projeto`.

## Scripts

- npm run dev: desenvolvimento com watch.
- npm run build: compila TypeScript para dist.
- npm start: executa build em produção.
- npm run typecheck: valida tipos sem gerar artefatos.
- npm test: executa testes unitarios.
- npm run test:watch: roda testes em modo watch.

## Banco de dados

Tabela principal:

- api_sessions: histórico de execução de agentes, tokens, custo e status.

Views úteis:

- daily_costs
- monthly_costs
- issue_costs

Scripts SQL em db:

- db/init.sql
- db/migrate_add_tokens.sql

## Status que disparam agentes

Configuráveis via .env:

- JIRA_TRIGGER_STATUS: dispara revisor.
- JIRA_ANALYST_TRIGGER_STATUS: dispara analista.
- JIRA_IMPLEMENTOR_TRIGGER_STATUS: dispara implementador.

## Troubleshooting rápido

- Erro de variáveis ausentes ao iniciar:
   - confira ANTHROPIC_API_KEY, JIRA_URL, JIRA_USER_EMAIL e JIRA_API_TOKEN.
- Webhook não dispara:
   - valide se o Jira envia POST para /webhook e se houve mudança de status.
- Webhook retorna 401:
   - valide JIRA_WEBHOOK_SECRET e o header de assinatura configurado.
- Sem logs no MySQL:
   - confira MYSQL_HOST e credenciais no .env.
- Push/PR falhando:
   - revise token do provedor configurado em GIT_PROVIDER.

## Segurança

- Nunca comite .env.
- Use tokens com menor privilégio possível.
- Prefira injetar segredos por variáveis de ambiente no runtime.
