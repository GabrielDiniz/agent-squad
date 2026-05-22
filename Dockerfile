# syntax=docker/dockerfile:1.7

# uv — gerenciador Python usado para rodar o MCP mcp-atlassian via uvx
FROM ghcr.io/astral-sh/uv:latest AS uv-bin

# =============================================================================
# Dev stage — hot-reload com tsx watch (src/ montado como bind mount)
# =============================================================================
FROM node:22-bookworm-slim AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        ripgrep \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# uv / uvx — necessário para executar o MCP mcp-atlassian
COPY --from=uv-bin /uv /uvx /usr/local/bin/

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

RUN mkdir -p /workspace && chown node:node /workspace

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
        ca-certificates \
        ripgrep \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# uv / uvx para o MCP mcp-atlassian
COPY --from=uv-bin /uv /uvx /usr/local/bin/

RUN groupadd --gid 1001 agent \
    && useradd --uid 1001 --gid agent --create-home --shell /bin/bash agent

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /workspace && chown -R agent:agent /workspace /app

USER agent

# pré-instala mcp-atlassian no cache do uvx para startup rápido
RUN uvx --from mcp-atlassian mcp-atlassian --help > /dev/null 2>&1 || true

ENV NODE_ENV=production
ENV AGENT_WORKDIR=/workspace

WORKDIR /workspace

EXPOSE 3000

CMD ["node", "/app/dist/index.js"]
