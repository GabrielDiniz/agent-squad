# 07 - URL Only de Codebases

## Objetivo

Mudar o contrato de codebases para operar por URL de repositório como fonte primária, removendo acoplamento com paths/volumes externos por projeto.

## Escopo

- Definir novo schema de codebase orientado a URL.
- Planejar compatibilidade temporária e data de remoção de campos legados.
- Definir comportamento quando repositório ainda não existe localmente.

## Entregáveis

1. Especificação do schema URL-first.
2. Regras de validação e normalização de URL.
3. Política de fallback/compatibilidade temporária.
4. Atualização da documentação funcional do mapeamento.

## Arquivos candidatos

- src/codebases.ts
- codebases.json
- .env.example
- README.md
- docs/CONTEXTO_TECNICO.md

## Critérios de aceite

1. `repository_url` passa a ser campo obrigatório para novos cadastros.
2. Sistema rejeita entrada inválida de URL com mensagem clara.
3. Documentação oficial reflete URL-first como padrão do produto.

## Dependências

- Nenhuma.

## Riscos

1. Mudança de contrato quebrar cadastros legados sem URL.
2. Ambiguidade de host/protocolo em URLs não padronizadas.

## Mitigações

1. Janela de compatibilidade com warning explícito.
2. Normalização centralizada e testes unitários de parse.
