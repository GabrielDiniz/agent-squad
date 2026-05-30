# 09 - Agentes com Auto-Clone

## Objetivo

Garantir que analista e implementador sempre operem em codebase existente localmente via fluxo automático de clone antes de iniciar tarefa.

## Escopo

- Integrar `ensureCloned` no carregamento de codebases dos agentes.
- Tornar o pré-clone etapa obrigatória do ciclo de execução.
- Propagar mensagens claras para o modelo quando clone falhar.

## Entregáveis

1. Analista com resolução local por URL e clone on-demand.
2. Implementador com mesma regra de pré-clone.
3. `list_codebases` exibindo estado local (pronto/erro).

## Arquivos candidatos

- src/agents/analyst.ts
- src/agents/implementor.ts
- src/codebases.ts

## Critérios de aceite

1. Agente não inicia leitura/edição sem codebase local pronto.
2. Clone automático ocorre antes do primeiro comando na codebase.
3. Erro de clone impede execução e informa causa.

## Dependências

- Fase 08 concluída.

## Riscos

1. Aumento de latência na primeira execução por repo.
2. Falhas intermitentes de rede afetarem confiabilidade.

## Mitigações

1. Retry com backoff para clone.
2. Cache local persistente por diretório de repositórios.
