# TODO Detalhado - 06 Operacao sem editar Compose

## Preparacao

- [x] Definir raiz unica de trabalho no host.
- [x] Definir convencao de layout dentro da raiz montada.

## Implementacao

- [x] Ajustar docker-compose.yml para montagem unica da raiz.
- [x] Ajustar docker-compose.dev.yml para mesma estrategia.
- [x] Configurar CODEBASES_ROOT para a raiz montada.
- [x] Definir CODEBASES_MODE discover ou hybrid para transicao.

## Fluxo operacional

- [x] Documentar onboarding de novo repositorio:
  - [x] adicionar/clonar repositorio na raiz montada
  - [x] subir/reiniciar servico
  - [x] validar descoberta via list_codebases
- [x] Documentar fallback para modo static em caso de incidente.

## Seguranca e governanca

- [x] Garantir que raiz montada nao exponha diretorios sensiveis.
- [x] Definir recomendacao para whitelist de hosts remotos, se aplicavel.

## Validacao

- [x] Subir stack com compose atualizado.
- [x] Adicionar novo repo na raiz sem alterar YAML.
- [x] Confirmar que agentes conseguem operar no novo repo.

## Criterio de concluido

- [x] Nao e necessario editar compose para cada novo codebase.
- [x] Fluxos dev e padrao permanecem estaveis.
