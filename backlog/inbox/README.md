# Inbox de Novos Requisitos

Use este arquivo para registrar requisitos que ainda nao viraram fase de execucao.

## Modelo de entrada

- Titulo:
- Contexto:
- Resultado esperado:
- Impacto:
- Prioridade: baixa | media | alta | critica
- Dependencias:
- Observacoes:

## Processo

1. Registrar item no inbox.
2. Refinar e quebrar em fase usando o template.
3. Criar TODO detalhado correspondente em active/todos.
4. Atualizar indice de fases.

## Requisitos registrados

- Titulo: URL-only para codebases com clone automático
- Contexto: eliminar dependência de volumes externos por repositório no runtime dos agentes.
- Resultado esperado: agentes resolvem codebase por URL, clonam se ausente localmente e só então iniciam tarefa.
- Impacto: mudança arquitetural no fluxo de descoberta, execução e operação.
- Prioridade: alta
- Dependências: política de credenciais Git e whitelist de hosts.
- Observações: executar rollout em fases com monitoramento de cold start e falhas de clone.
- Status: concluído (fases 07 a 11)

- Titulo: Fila com workers e locks SQL com compatibilidade Redis
- Contexto: execução síncrona e concorrência direta entre agentes aumenta risco de colisões por issue e codebase.
- Resultado esperado: webhook apenas enfileira, workers processam jobs com lock por issue/codebase e controle de retries.
- Impacto: alta mudança arquitetural no pipeline de execução e modelo de consistência operacional.
- Prioridade: critica
- Dependências: definição de contrato de job/estado, migração SQL e política de idempotência.
- Observações: implementar em backend SQL primeiro, mantendo interfaces para futura migração para Redis.
- Status: planejado (fases 12 a 18)
