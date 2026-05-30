# TODO Detalhado - 04 Testes ADF

## Preparacao

- [x] Escolher e instalar runner de testes (Vitest recomendado).
- [x] Definir estrutura de pastas para testes unitarios.

## Implementacao de base

- [x] Configurar script npm test no package.json.
- [x] Configurar ambiente TS para testes.
- [x] Exportar helpers necessarios de src/jira.ts sem acoplamento indevido.

## Casos de teste

- [x] Criar testes para headings.
- [x] Criar testes para bold e italic.
- [x] Criar testes para inline code.
- [x] Criar testes para links.
- [x] Criar testes para listas bullet e ordered.
- [x] Criar testes para blockquote.
- [x] Criar testes para code fence.
- [x] Criar testes para tabela markdown.
- [x] Criar testes para entrada vazia e nula.
- [x] Criar testes de regressao com payload semelhante ao Jira real.

## Qualidade dos testes

- [x] Evitar snapshots gigantes; validar estrutura relevante.
- [x] Garantir nomes de teste descritivos.
- [x] Garantir independencia entre casos.

## Validacao

- [x] Rodar npm test com sucesso localmente.
- [x] Revisar cobertura minima dos caminhos principais.

## Criterio de concluido

- [x] Conversao Markdown <-> ADF coberta nos cenarios criticos.
- [x] Suite reproduzivel no ambiente de desenvolvimento.
