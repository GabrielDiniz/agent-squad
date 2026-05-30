# TODO Detalhado - 08 Repo Resolver e Clone

## Preparação

- [x] Definir diretório raiz de repositórios locais.
- [x] Definir estratégia de slug/canonical path por URL.
- [x] Definir política de concorrência para clone.

## Implementação

- [x] Criar módulo `repository.ts` com resolver por URL.
- [x] Implementar `ensureCloned(repositoryUrl)` idempotente.
- [x] Implementar lock por repo para evitar corrida.
- [x] Implementar timeout e retry básico no clone.
- [x] Propagar erro estruturado para camada de agentes.

## Observabilidade

- [x] Logar início/fim de clone por repo.
- [x] Logar tempo de clone.
- [x] Logar classe de erro sem vazar segredo.

## Validação

- [x] Repo inexistente local deve ser clonado automaticamente.
- [x] Repo já existente não deve reclonar.
- [x] Duas chamadas paralelas para mesma URL não devem duplicar clone.

## Critério de concluído

- [x] Serviço de clone on-demand estável e reutilizável pelos agentes.
