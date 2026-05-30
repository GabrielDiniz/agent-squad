# Etapa 06 - Operacao sem editar docker-compose para novos codebases

## Objetivo

Eliminar necessidade de adicionar um volume por repositório no compose para cada novo codebase.

## Escopo

1. Definir padrao de montagem unica da raiz de trabalho.
2. Ajustar compose para operar com descoberta dinamica.
3. Documentar onboarding de novo codebase sem alterar YAML.

## Arquivos candidatos

- docker-compose.yml
- docker-compose.dev.yml
- README.md
- docs/CONTEXTO_TECNICO.md

## Estrategia recomendada

1. Manter um unico volume de raiz:
   - host root -> /workspace no container.
2. Definir CODEBASES_ROOT=/workspace.
3. Ativar CODEBASES_MODE=discover (ou hybrid em transicao).
4. Opcional: preservar codebases.json apenas para metadados enriquecidos.

## Tarefas executaveis

1. Revisar volumes atuais e remover acoplamento por repositorio fixo.
2. Ajustar env no compose para modo dinamico.
3. Validar que a aplicacao ainda enxerga repositorios existentes na raiz.
4. Documentar fluxo de onboarding:
   - copiar/clonar repo na raiz montada
   - subir servico
   - confirmar listagem dinamica
5. Definir fallback operacional para ambientes que ainda dependem do modo static.

## Criterios de aceite

1. Novo repositório aparece sem editar compose.
2. Analista e implementador conseguem usar novo codebase no mesmo ciclo de execucao.
3. Compose continua funcional em dev e modo padrao.

## Testes

1. Subir stack com montagem unica.
2. Adicionar novo repositório sob /workspace e reiniciar app.
3. Confirmar descoberta via ferramenta list_codebases.
4. Confirmar fluxo de implementacao em codebase descoberto.

## Riscos

1. Montagem ampla demais expor diretorios nao desejados.
2. Ambientes CI/CD com paths diferentes quebrarem descoberta.

## Mitigacoes

1. Definir raiz explicita e controlada.
2. Documentar convencao de layout para host e pipeline.

## Evidencias esperadas no PR

1. Diff de compose com montagem unica.
2. Passo a passo de onboarding sem editar YAML.
3. Demonstracao do codebase novo sendo listado e utilizado.

## Estimativa

- Esforco: medio.
- Risco: medio.
