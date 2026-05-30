# TODO Detalhado - 07 URL Only de Codebases

## Preparação

- [x] Definir contrato final do schema URL-first.
- [x] Definir janela de compatibilidade para campos legados.
- [x] Definir mensagens de erro padrão para validação de URL.

## Implementação

- [x] Tornar `repository_url` obrigatório para novos cadastros.
- [x] Aceitar aliases de URL apenas como compatibilidade temporária.
- [x] Validar protocolo e formato básico da URL.
- [x] Normalizar URL para comparação consistente.

## Documentação

- [x] Atualizar exemplos em `codebases.json`.
- [x] Atualizar README com fluxo URL-first.
- [x] Atualizar contexto técnico com novo contrato.

## Validação

- [x] Cadastro com URL válida deve carregar.
- [x] Cadastro sem URL deve gerar erro claro.
- [x] URL inválida deve ser rejeitada com causa específica.

## Critério de concluído

- [x] Modelo URL-first adotado e documentado.
