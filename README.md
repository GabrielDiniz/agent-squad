# claude-agent-squad

Setup inicial em TypeScript para rodar agentes Claude (Agent SDK) em container.

## Estrutura

```
.
├── Dockerfile          # multi-stage, runtime sem dev deps, usuário não-root
├── .dockerignore
├── .env.example        # copie para .env e preencha a chave
├── .gitignore
├── package.json
├── tsconfig.json
└── src/
    └── index.ts        # agente inicial (sanity check)
```

## Rodando localmente (sem Docker)

```bash
npm install
cp .env.example .env       # depois edite e cole sua chave
npm run dev                # roda com tsx, hot reload
```

## Rodando com Docker

Build:

```bash
docker build -t claude-agent-squad .
```

Run (passando a chave via --env-file):

```bash
docker run --rm \
  --env-file .env \
  -v "$(pwd)/workspace":/workspace \
  claude-agent-squad
```

Ou com prompt customizado:

```bash
docker run --rm --env-file .env claude-agent-squad \
  node /app/dist/index.js "Conte quantos arquivos .ts existem aqui"
```

> A chave NUNCA vai dentro da imagem. Sempre via `--env-file`, `-e`, ou
> secret do orquestrador (ECS task secrets, K8s Secret, etc).

## Próximos passos

1. **Conectar MCP do Jira**: adicionar `mcpServers` nas options do `query()`
   apontando para `https://mcp.atlassian.com/v1/mcp`.
2. **Definir subagents**: usar a opção `agents` para criar especialistas
   (triage, code-explorer, implementer, pr-opener) com `allowedTools`
   restritos por papel.
3. **Trigger de produção**: substituir o prompt CLI por um servidor HTTP
   (Fastify/Hono) ou um worker reagindo a webhook do Jira.
4. **Observabilidade**: agregar logs estruturados + métricas de custo
   (campo `total_cost_usd` do evento `result`).
