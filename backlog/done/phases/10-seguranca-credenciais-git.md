# 10 - Segurança e Credenciais Git

## Objetivo

Fortalecer segurança do fluxo de clone automático com políticas explícitas de host permitido, autenticação e proteção contra URL maliciosa.

## Escopo

- Aplicar whitelist por host de repositório.
- Validar esquema/protocolo permitido.
- Garantir não exposição de tokens em logs.
- Revisar estratégia de credenciais em runtime.

## Entregáveis

1. Política de hosts permitidos aplicada no resolver.
2. Bloqueio de URLs fora da política.
3. Sanitização de logs para segredos.
4. Documento operacional de credenciais por provedor.

## Arquivos candidatos

- src/codebases.ts
- src/git.ts
- src/repository.ts
- .env.example
- README.md

## Critérios de aceite

1. URL fora de whitelist é rejeitada antes do clone.
2. Nenhuma credencial aparece em logs de erro/sucesso.
3. Fluxo GitHub/GitLab/Bitbucket continua funcional.

## Dependências

- Fase 08 concluída.

## Riscos

1. Política restritiva bloquear uso legítimo.
2. Diferença entre cloud/self-hosted em autenticação.

## Mitigações

1. Lista de hosts configurável por ambiente.
2. Testes de integração por provedor suportado.
