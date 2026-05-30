# TODO Detalhado - 05 Registry Dinamico de Codebases

## Preparacao

- [x] Definir contrato de configuracao:
  - [x] CODEBASES_MODE
  - [x] CODEBASES_ROOT
  - [x] CODEBASES_CONFIG
  - [x] CODEBASES_CACHE_PATH
  - [x] CODEBASES_ALLOWED_HOSTS
- [x] Definir prioridade de resolucao entre modos.

## Implementacao

- [x] Criar modulo central src/codebases.ts.
- [x] Implementar loadStaticCodebases().
- [x] Implementar discoverLocalCodebases(root).
- [x] Implementar mergeHybrid(static, discovered).
- [x] Implementar deduplicacao por nome e caminho canonico.
- [x] Implementar fallback seguro para /workspace.

## Integracao com agentes

- [x] Substituir loadCodebases duplicado em analyst.
- [x] Substituir loadCodebases duplicado em implementor.
- [x] Garantir formato de retorno compativel com ferramentas list_codebases/list_modules.

## Observabilidade

- [x] Adicionar logs de modo ativo (static/discover/hybrid).
- [x] Adicionar log de quantidade de codebases encontrados.
- [x] Adicionar log de conflitos e deduplicacao.

## Compatibilidade

- [x] Preservar comportamento atual no modo static.
- [x] Preservar metadados ricos de codebases.json no modo hybrid.

## Validacao

- [x] Testar modo static com arquivo atual.
- [x] Testar modo discover sem arquivo estatico.
- [x] Testar modo hybrid com sobreposicao de entradas.

## Criterio de concluido

- [x] Agentes usam fonte unica de verdade.
- [x] Novo codebase local pode ser descoberto sem declaracao manual no compose.
