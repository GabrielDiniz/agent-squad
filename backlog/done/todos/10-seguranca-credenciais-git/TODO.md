# TODO Detalhado - 10 Segurança e Credenciais Git

## Preparação

- [x] Definir política de hosts permitidos por ambiente.
- [x] Definir protocolos permitidos por host.
- [x] Revisar padrões de logging para secrets.

## Implementação

- [x] Aplicar whitelist de host no resolver/clone.
- [x] Bloquear URL fora da política.
- [x] Sanitizar logs de URL com credenciais embutidas.
- [x] Garantir uso correto de tokens por provedor.

## Documentação

- [x] Atualizar `.env.example` com variáveis de política de host.
- [x] Documentar fluxo de credencial por provider.
- [x] Documentar falhas comuns de autenticação.

## Validação

- [x] URL permitida deve passar.
- [x] URL bloqueada deve falhar antes do clone.
- [x] Logs não exibem credenciais sensíveis.

## Critério de concluído

- [x] Política de segurança aplicada sem quebrar fluxos legítimos.
