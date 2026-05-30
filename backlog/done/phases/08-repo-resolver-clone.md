# 08 - Repo Resolver e Clone

## Objetivo

Implementar camada central para resolver destino local por URL e clonar repositórios ausentes antes do uso pelos agentes.

## Escopo

- Criar serviço de resolução local de diretório por URL.
- Implementar `ensureCloned` com `git clone` seguro e idempotente.
- Adicionar lock para evitar clones concorrentes do mesmo repo.
- Definir política de atualização inicial (clone-only vs fetch opcional).

## Entregáveis

1. Módulo de repositório (resolver + clone + lock).
2. Tratamento de erros operacionais (auth, rede, URL inválida).
3. Logs estruturados de sucesso/falha no clone.

## Arquivos candidatos

- src/codebases.ts
- src/git.ts
- src/repository.ts (novo)
- src/bootstrap.ts

## Critérios de aceite

1. Dado um `repository_url` válido, o sistema calcula path local determinístico.
2. Se o diretório não existir, clona automaticamente com sucesso.
3. Chamadas paralelas para mesma URL não causam clone duplicado.
4. Erros retornam mensagens acionáveis.

## Dependências

- Fase 07 concluída.

## Riscos

1. Corrida de clone em múltiplas tarefas simultâneas.
2. Credenciais insuficientes em ambiente containerizado.

## Mitigações

1. Lock file/process por slug de repositório.
2. Diagnóstico detalhado de auth e host.
