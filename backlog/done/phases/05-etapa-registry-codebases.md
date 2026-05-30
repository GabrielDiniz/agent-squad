# Etapa 05 - Registry Dinamico de Codebases

## Objetivo

Implementar mapeamento dinamico de codebases para que novos repositorios possam ser descobertos/usados sem dependencia de declaracao manual em compose.

## Escopo

1. Criar camada de registry de codebases.
2. Suportar modos de operacao: static, discover e hybrid.
3. Integrar analista e implementador ao novo provider.

## Arquivos candidatos

- src/agents/analyst.ts
- src/agents/implementor.ts
- src/codebases.ts (novo)
- src/bootstrap.ts
- .env.example
- docs/CONTEXTO_TECNICO.md
- README.md

## Contrato de configuracao

- CODEBASES_MODE: static | discover | hybrid
- CODEBASES_CONFIG: caminho do arquivo estatico
- CODEBASES_ROOT: raiz de descoberta local
- CODEBASES_CACHE_PATH: indice local opcional
- CODEBASES_ALLOWED_HOSTS: whitelist para origem remota (se habilitado)

## Tarefas executaveis

1. Implementar provider unificado de codebases:
   - loadStaticCodebases()
   - discoverLocalCodebases(root)
   - mergeHybrid(static, discovered)
2. Regra de deduplicacao por nome e caminho canonico.
3. Descoberta local:
   - varrer subpastas de CODEBASES_ROOT
   - identificar repositorio Git pela pasta .git
   - coletar nome e caminho
4. Integrar provider nos agentes, substituindo loadCodebases local duplicado.
5. Manter compatibilidade com codebases.json atual.
6. Adicionar logs de diagnostico de descoberta.
7. Atualizar prompts/ferramentas dos agentes para refletir lista dinamica.

## Criterios de aceite

1. Em modo static, comportamento atual permanece.
2. Em modo discover, codebases locais sao listados sem codebases.json.
3. Em modo hybrid, listas sao combinadas sem duplicacao.
4. Analista e implementador usam mesma fonte de verdade.

## Testes

1. Validar retorno em cada modo de CODEBASES_MODE.
2. Validar deduplicacao quando repositorio existe nas duas fontes.
3. Validar fallback seguro para /workspace quando variaveis ausentes.

## Riscos

1. Discovery incluir diretorios indevidos.
2. Mudanca quebrar cenarios em que descricao/modulos sao essenciais.

## Mitigacoes

1. Filtros de descoberta (somente pastas com .git).
2. Em modo hybrid preservar metadados ricos do estatico quando houver match.

## Evidencias esperadas no PR

1. Saida de list_codebases em cada modo.
2. Exemplo de descoberta sem arquivo estatico.
3. Documentacao atualizada com matriz de modos.

## Estimativa

- Esforco: medio para alto.
- Risco: medio.
