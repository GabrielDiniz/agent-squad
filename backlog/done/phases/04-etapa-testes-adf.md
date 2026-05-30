# Etapa 04 - Testes de Conversao Markdown <-> ADF

## Objetivo

Blindar a conversao usada pelo Jira contra regressao funcional.

## Escopo

1. Introduzir framework de testes unitarios para o projeto.
2. Cobrir funcoes de leitura/escrita ADF.
3. Criar suite de casos reais e casos limite.

## Arquivos candidatos

- src/jira.ts
- package.json
- tsconfig.json (se necessario)
- src/__tests__/jira-adf.test.ts (novo)
- docs/CONTEXTO_TECNICO.md

## Tarefas executaveis

1. Escolher framework de testes (Vitest recomendado).
2. Configurar script npm test.
3. Extrair/organizar funcoes para facilitar teste unitario, se necessario.
4. Criar testes para:
   - headings
   - bold, italic, inline code
   - links
   - listas ordenadas e nao ordenadas
   - blockquote
   - code fence
   - tabela markdown simples
5. Criar testes de robustez para entrada vazia ou nula.
6. Criar ao menos 2 testes de regressao com payload semelhante ao Jira real.

## Criterios de aceite

1. Suite roda localmente com comando unico.
2. Conversao basica e cenarios limite cobertos.
3. Nao ha alteracao de comportamento sem teste correspondente.

## Testes

1. npm test executa sem falhas.
2. Caso de tabela markdown gera estrutura ADF esperada.
3. Conversao de comentario com link + code funciona.

## Riscos

1. Acoplamento com modulo Jira dificultar isolamento.
2. Diferenças de serializacao JSON causarem fragilidade dos testes.

## Mitigacoes

1. Separar helpers puros quando preciso.
2. Evitar snapshot gigante; preferir assercoes por estrutura.

## Evidencias esperadas no PR

1. Saida do runner de testes.
2. Lista de casos cobertos.
3. Relacao entre bug potencial e caso de teste adicionado.

## Estimativa

- Esforco: medio.
- Risco: baixo para runtime, medio para setup inicial.
