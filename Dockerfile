# syntax=docker/dockerfile:1.7

# uv — gerenciador Python usado para rodar o MCP mcp-atlassian via uvx
FROM ghcr.io/astral-sh/uv:latest AS uv-bin

# =============================================================================
# Dev stage — hot-reload com tsx watch (src/ montado como bind mount)
# =============================================================================
FROM node:22-bookworm-slim AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        openssh-client \
        ca-certificates \
        curl \
        ripgrep \
        python3 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Pre-populate SSH known hosts (system-wide) so git SSH ops never prompt for host verification
RUN ssh-keyscan -H bitbucket.org github.com gitlab.com ssh.dev.azure.com >> /etc/ssh/ssh_known_hosts 2>/dev/null || true

# uv / uvx — necessário para executar o MCP mcp-atlassian
COPY --from=uv-bin /uv /uvx /usr/local/bin/

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Cria /workspace/codebases com o owner correto ANTES do USER node.
# Volumes nomeados novos/vazios herdam essa estrutura da imagem; volumes já
# existentes com root:root devem ser recriados: docker volume rm <nome>.
RUN mkdir -p /workspace/codebases && chown -R node:node /workspace

USER node

# pré-aquece o cache do uvx para não baixar mcp-atlassian no primeiro request
RUN uvx --from mcp-atlassian mcp-atlassian --help > /dev/null 2>&1 || true

ENV NODE_ENV=development
ENV AGENT_WORKDIR=/workspace

# src/ e tsconfig.json chegam via bind mount — não copiados aqui
CMD ["npm", "run", "dev"]


# =============================================================================
# Builder stage — compila TypeScript
# =============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# =============================================================================
# Runtime stage — imagem final, enxuta e sem dev deps
# =============================================================================
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        openssh-client \
        ca-certificates \
        curl \
        ripgrep \
        python3 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Pre-populate SSH known hosts (system-wide) so git SSH ops never prompt for host verification
RUN ssh-keyscan -H bitbucket.org github.com gitlab.com ssh.dev.azure.com >> /etc/ssh/ssh_known_hosts 2>/dev/null || true

# uv / uvx para o MCP mcp-atlassian
COPY --from=uv-bin /uv /uvx /usr/local/bin/

RUN groupadd --gid 1001 agent \
    && useradd --uid 1001 --gid agent --create-home --shell /bin/bash agent

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Cria /workspace/codebases com o owner correto ANTES do USER agent.
RUN mkdir -p /workspace/codebases && chown -R agent:agent /workspace /app

USER agent

# pré-instala mcp-atlassian no cache do uvx para startup rápido
RUN uvx --from mcp-atlassian mcp-atlassian --help > /dev/null 2>&1 || true

ENV NODE_ENV=production
ENV AGENT_WORKDIR=/workspace

WORKDIR /workspace

EXPOSE 3000

CMD ["node", "/app/dist/index.js"]
