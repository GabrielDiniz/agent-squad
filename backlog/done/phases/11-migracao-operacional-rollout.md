# 11 - Migração Operacional e Rollout

## Objetivo

Concluir migração para modelo URL-only com clone automático, removendo dependência operacional de volumes externos por codebase.

## Escopo

- Ajustar compose e variáveis para nova arquitetura.
- Migrar cadastro dos codebases existentes para URL-first.
- Definir plano de rollout, observabilidade e rollback.

## Entregáveis

1. Guia de migração operacional.
2. Compose/documentação sem instruções de volume por repo.
3. Checklist de rollout por ambiente.
4. Métricas pós-migração (sucesso de clone, tempo inicial, falhas auth).

## Arquivos candidatos

- docker-compose.yml
- docker-compose.dev.yml
- codebases.json
- README.md
- docs/CONTEXTO_TECNICO.md

## Critérios de aceite

1. Novo projeto entra apenas com URL no cadastro.
2. Primeira tarefa clona automaticamente repo ausente.
3. Fluxos principais executam sem volume externo dedicado.
4. Procedimento de rollback documentado.

## Dependências

- Fases 09 e 10 concluídas.

## Riscos

1. Impacto de performance no cold start.
2. Falha de clone em massa no primeiro ciclo.

## Mitigações

1. Pré-warm opcional de repositórios críticos.
2. Acompanhamento de métricas e alertas no rollout.
