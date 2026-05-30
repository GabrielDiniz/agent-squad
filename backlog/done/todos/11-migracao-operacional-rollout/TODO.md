# TODO Detalhado - 11 Migração Operacional e Rollout

## Preparação

- [x] Inventariar projetos atualmente dependentes de volume dedicado.
- [x] Definir janela de rollout por ambiente.
- [x] Definir plano de rollback em caso de falha.

## Implementação

- [x] Atualizar compose para remover instruções de volume por projeto.
- [x] Ajustar docs para onboarding somente por URL.
- [x] Migrar entradas existentes em `codebases.json` para URL-first.

## Rollout

- [x] Executar piloto com 1-2 projetos reais.
- [x] Medir tempo de cold clone.
- [x] Ajustar retry/timeout conforme resultados.
- [x] Expandir rollout para todos os projetos.

## Observabilidade

- [x] Monitorar taxa de sucesso de clone.
- [x] Monitorar taxa de falha por auth/rede.
- [x] Monitorar impacto no tempo de execução da primeira tarefa.

## Critério de concluído

- [x] Operação padrão sem dependência de volume externo por codebase.
- [x] Processo de entrada de novo projeto definido e validado.
