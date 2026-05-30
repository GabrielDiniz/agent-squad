# TODO Detalhado - 09 Agentes com Auto-Clone

## Preparação

- [x] Mapear pontos de entrada de codebases no analista.
- [x] Mapear pontos de entrada de codebases no implementador.
- [x] Definir contrato de retorno de status local do codebase.

## Implementação

- [x] Integrar `ensureCloned` no fluxo do analista.
- [x] Integrar `ensureCloned` no fluxo do implementador.
- [x] Bloquear execução quando clone falhar.
- [x] Atualizar `list_codebases` com estado local e URL.

## Tratamento de erro

- [x] Mensagem para erro de autenticação Git.
- [x] Mensagem para timeout/rede.
- [x] Mensagem para host não permitido.

## Validação

- [x] Analista executa tarefa em repo ausente localmente.
- [x] Implementador executa tarefa em repo ausente localmente.
- [x] Tarefa aborta corretamente em falha de clone.

## Critério de concluído

- [x] Nenhum agente depende de volume externo dedicado por repo.
