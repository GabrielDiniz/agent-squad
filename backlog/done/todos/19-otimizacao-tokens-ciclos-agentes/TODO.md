# TODO - Fase 19: Otimizacao de Tokens e Ciclos dos Agentes

## Objetivo operacional

Diminuir custo por execução e número de ciclos necessários para concluir uma issue, sem perder robustez de tool_use, consistência de histórico e qualidade dos resultados.

## Checklist detalhado

### 1) Baseline e telemetria

- [ ] Definir baseline atual por agente: tokens in/out por issue, turnos médios, custo estimado, tempo médio de conclusão.
- [ ] Persistir métricas mínimas por sessão para comparação antes/depois.
- [ ] Criar métricas derivadas: `tokens_por_turno`, `custo_por_issue`, `turnos_por_issue`, `taxa_max_tokens`, `taxa_sucesso`.
- [ ] Validar que as métricas são geradas sem impacto perceptível de performance.

### 2) Prompt engineering orientado a custo

- [ ] Reduzir verbosidade dos `buildPrompt(...)` removendo instruções duplicadas.
- [ ] Separar prompt por fase operacional (discovery, execução, publicação).
- [ ] Introduzir diretriz explícita de resposta curta fora de `tool_use`.
- [ ] Garantir que instruções críticas (segurança, ordem de execução, padrões) permaneçam preservadas.

### 3) Política de budget e limites

- [x] Definir limites padrão de `max_tokens` por agente e por fase.
- [x] Introduzir budget total por execução (hard/soft limit).
- [x] Em soft-limit, forçar modo objetivo (tool-first + sem explicações longas).
- [x] Em hard-limit, aplicar encerramento seguro com status e comentário Jira quando necessário.

### 4) Modo tool-first e redução de saída

- [x] Aplicar regra: quando ação de ferramenta for necessária, priorizar apenas `tool_use`.
- [x] Reduzir `MAX_OUTPUT_CHARS` de comandos read-only para evitar resposta inflada.
- [ ] Forçar leituras segmentadas (`sed -n`) para arquivos grandes.
- [x] Evitar repetição de outputs já vistos no mesmo ciclo.

### 5) Sumarização incremental de histórico

- [x] Implementar snapshot compacto de estado a cada N turnos.
- [x] Substituir partes antigas do histórico por resumo estruturado quando exceder limiar.
- [x] Preservar no resumo: objetivo, decisões, arquivos alvo, pendências e último tool_result crítico.
- [x] Validar que tool chains não quebram após compactação de histórico.

### 6) Cache por issue e invalidação

- [x] Cachear resultados estáveis de `jira_get_issue`, `list_codebases`, `list_modules` por execução.
- [ ] Definir política de invalidação por evento de mudança de status/changelog.
- [ ] Evitar cache para operações sensíveis a estado mutável.
- [x] Registrar hits/misses para medir ganho real.

### 7) Recuperação e robustez de loop

- [x] Consolidar estratégia de recuperação para `max_tokens` já aplicada nos agentes.
- [x] Adicionar limite de recuperações consecutivas para evitar loop infinito.
- [x] Em limite excedido, gerar saída operacional curta + comentário Jira orientativo.
- [ ] Garantir finalização de sessão consistente no banco em todos os cenários.

### 8) Rollout, flags e rollback

- [x] Introduzir feature flags para cada mecanismo (prompt compacto, snapshot, cache, budget).
- [x] Definir ordem de rollout: reviewer -> analyst -> implementor.
- [x] Definir critérios objetivos de rollback (degradação de taxa de sucesso, aumento de tempo, erro de tool chain).
- [x] Documentar runbook de ativação/desativação por ambiente.

### 9) Testes e validação

- [ ] Atualizar/expandir testes unitários dos loops dos agentes.
- [ ] Cobrir cenários de recuperação de `max_tokens` com continuação de fluxo.
- [ ] Cobrir cenários de cache e invalidação.
- [ ] Validar regressão operacional em fluxo completo via worker.

### 10) Documentação final

- [x] Atualizar README com flags de otimização e parâmetros recomendados.
- [x] Atualizar docs técnicas com arquitetura de budget/snapshot/cache.
- [ ] Registrar tabela antes/depois com resultados consolidados.
- [ ] Preparar checklist de operação para observabilidade contínua.

## Plano de execução por incrementos

1. Incremento A (baixo risco): baseline + ajustes de limites + tool-first.
2. Incremento B (médio risco): snapshot incremental + cache por issue.
3. Incremento C (médio-alto risco): budget manager completo + policies de fallback.
4. Incremento D (hardening): rollout progressivo, tuning e documentação final.

## Evidências esperadas

- Comparativo antes/depois com redução percentual de tokens e turnos.
- Execuções reais sem regressão funcional (sucesso de transições e comentários Jira).
- Logs demonstrando redução de respostas narrativas e maior uso de tool_use.
- Registro de incidentes zero para corrupção de histórico/tool_result.

## Status

- Concluída.
- Itens remanescentes devem seguir como melhoria contínua em nova fase/iniciativa.
