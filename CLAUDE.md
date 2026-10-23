# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Checagem de fatos **ao vivo** do debate presidencial de 23/10/2026: captura a transmissão, transcreve, extrai afirmações checáveis, verifica contra uma base pré-carregada + web e publica **alertas curtos que sempre trazem fonte** (URL + trecho verificado). Prioridade: **precisão > latência > cobertura — na dúvida, silêncio**. Código, comentários, commits e UI em português do Brasil.

## Comandos

Monorepo pnpm (Node 22). Pacotes: `@actually/{db,pipeline,web,capture,kb-ingest,eval,acceptance}`.

```bash
pnpm install
pnpm typecheck                     # todos os pacotes
pnpm test                          # todos (para no primeiro pacote que falhar)
pnpm --filter @actually/pipeline test
pnpm --filter @actually/pipeline exec vitest run test/score.test.ts -t "regras duras"   # um teste
pnpm --filter @actually/web build  # precisa de NEXT_PUBLIC_SUPABASE_URL/ANON_KEY (qualquer valor serve no build)
pnpm --filter @actually/web test:e2e   # Chromium contra o build (modo demo, sem Supabase); rode build antes
pnpm --filter @actually/db test        # schema real em PGlite (node test/schema.check.mjs)
pnpm --filter @actually/capture start -- run|daemon|doctor|devices|install-service ...
pnpm --filter @actually/kb-ingest start -- tiers|indicators|factchecks|documents|senado|transcribe|apify-*|embed-missing|status [--dry-run]
pnpm eval -- --data eval/data/smoke.jsonl     # usa evaluateText (precisa das chaves)
```

CI (`.github/workflows/ci.yml`): typecheck → `pnpm test` → build do site → testes de navegador. A `main` deve ficar verde.

## Arquitetura (o que exige ler vários arquivos)

Fluxo: `apps/capture` (máquina do usuário, ffmpeg + Deepgram streaming) → `POST /api/ingest/segment` (Vercel) → grava `segments` e roda `runPipeline(segmentId)` em `after()` → grava `claims`/`verifications`/`evidence`/`alerts` no Supabase → público recebe via Realtime em `alerts`, com fallback de polling em `GET /api/alerts` (cache de CDN `s-maxage=2`). O pipeline roda **uma vez por segmento**, nunca por espectador.

- **`supabase/migrations/`** é a fonte da verdade do schema. Garantias vivem no banco, não no prompt:
  - trigger `alerts_require_evidence`: alerta não vira `published` sem `evidence` com URL http(s) e `quote_verified = true` (vale também para aprovação no /editor);
  - `segments`, `verifications`, `evidence`, `alert_events` são append-only; `alerts` não pode ser apagado;
  - RLS: anon só lê alertas `published` (+ evidência ligada); escrita só service role ou editor (`is_editor()`); tabelas `kb_*`/`indicator_*` só service role;
  - debate de teste (`debates.is_test`, padrão no /admin): anon não vê nada dele (`public_debate()` nas políticas; rotas com service role filtram à mão, `/api/alerts?preview=1` só com editor e sem cache) e `match_verified_claims` não reaproveita vereditos dele em outros debates; prévia do editor em `/admin/previa/[slug]`;
  - índice único parcial `claims (debate_id, claim_hash) where duplicate_of is null` = trava de repetição contra corrida;
  - `capture_heartbeat()` faz failover atômico entre agentes de captura (só service role executa); `capture_agent_delete()` (editor) remove agente parado há ≥ 1 min e sem falas — quem gravou `segments` fica;
  - fila `kb_web_finds` (só service role): páginas que a L4 trouxe; `kb_web_finds_claim()` entrega em lote com skip locked; o que vira base por ela leva `origin = 'web'` em `kb_documents`/`kb_factchecks`.
  Mudou o schema? Atualize `packages/db/src/types.ts` no mesmo commit e aplique a migration no projeto Supabase.
- **`packages/db`**: tipos espelhando o schema, contratos HTTP zod (`contracts.ts`) usados por web e capture, `DEFAULT_SETTINGS`/`resolveSettings` (thresholds e chaves HITL ficam em `debates.settings`), e `SOURCE_TIERS` — lista canônica de fontes por confiabilidade (tier 1–4) usada pelo pipeline, pela busca web (`webSearchDomains`) e gerada em `docs/metodologia.md`.
- **`packages/pipeline`**: `createPipeline(deps)` com dependências injetadas (`deps.ts`; banco atrás de `PipelineStore` em `store.ts`) — `runPipeline`/`evaluateText` exportados usam `defaultDeps()` do env. Etapas: `prefilter` → `extract` (Haiku, saída estruturada; classifica o tipo da fala — promessa e opinião pura são descartadas, opinião mensurável/previsão/acusação têm regras próprias em `KIND_RULES`) → `dedup` → `retrieve/` (L1 checagens, L2 indicadores e fatos de referência — mandatos e eleições em `ref_*`, conta em `retrieve/reference.ts` —, L3 documentos em paralelo; L4 web começa junto e só entra se a base vier fraca) → `verify` (Sonnet) → `quoteCheck` (trecho e números precisam existir literalmente na fonte) → `score` (regras duras: vermelho só com fonte tier ≤ 3 verificada — tier ≤ 1 em acusação; tier 4 nunca; o tier pesa no score, então nível 3 sozinho raramente passa do limiar; web soma `web_penalty`) → `publish` (`pending_review` se HITL ligado). Qualquer falha de dependência ⇒ silêncio, nunca exceção. Constantes calibráveis em `src/config.ts`.
- **`apps/web`** (Next.js 16, App Router, Tailwind 4): `/ao-vivo/[slug]` (feed + player opcional; `DisclaimerGate` bloqueante), `/ao-vivo/demo` e `/admin/demo` servem de fixtures sem Supabase (usados pelos testes e2e), `/editor` (fila HITL, mapa de speakers), `/admin` em abas (`components/staff/AdminTabs.tsx`; link direto por `#aba`): Ao vivo (máquinas de captura remotas, alertas, latência, neutralidade), Debates (criar/editar, settings), Base de conhecimento, Uso das APIs. Código servidor em `lib/server` (service role só nas rotas de ingest/controle/alertas; token `x-ingest-token` comparado em tempo constante); hooks de tempo real em `lib/live`.
- **`apps/capture`**: `run` (fonte youtube/device/file) e `daemon` (consulta `/api/control/poll` e obedece ao estado desejado definido no /admin: iniciar, agendar, parar; mantém a captura se a API de controle cair). `segmenter.ts` e `reconcile.ts` são funções puras.
- **`apps/kb-ingest`**: cargas idempotentes da base (Google Fact Check + agências, BCB SGS/IBGE SIDRA, documentos, Senado, Apify, transcrição Deepgram em lote). `src/jobs/` (exportado como `@actually/kb-ingest/jobs`) é a mesma carga em etapas curtas com prazo para o painel do /admin: rotas `/api/kb/*` (editor por Bearer + `is_editor()`; `/api/kb/run` e o cron diário só com `CRON_SECRET`) gravam em `kb_jobs` e rodam o executor em `after()`, encadeando a próxima rodada por fetch. Mudou `sources/*.yaml`? Rode `gen:sources`.
- **A base aprende com a web**: depois de publicar os alertas do trecho, o pipeline grava em `kb_web_finds` as páginas L4 (nível 1–2, texto inteiro; `KB_LEARN_FROM_WEB=0` desliga); a rota de ingestão garante a carga `capturas-web` e chama o executor; a etapa `web-finds` do kb-ingest vira checagem L1 (agência com selo) ou documento L3. Download recusado pelo site (HTTP, nunca robots.txt) cai para a Tavily (extract); matéria de agência com várias falas checadas vira documento L3; `checagens-agencias` busca pela Tavily as checagens recentes das agências.
- **Uso das APIs**: pipeline (`src/usage.ts`, `UsageMeter` em `deps.usage`) e kb-ingest (`lib/usage.ts`) contam chamadas/tokens/créditos e gravam uma vez por trecho/etapa via RPC `api_usage_add` (agregado por hora em `api_usage`; cabeçalhos `*ratelimit*` em `api_ratelimits`); falha ao gravar só loga. `GET /api/ops/usage` (`lib/server/apiUsage.ts`, editor, cache 60 s) junta isso ao que cada provedor informa (Admin API da Anthropic, Deepgram, Apify, Tavily, `ops_db_size`), 5 s e falha isolada por provedor, nunca devolve chave. Preço da Anthropic em `packages/pipeline/src/config.ts`.
- **`eval/`**: precisão/recall de alertas e latência sobre conjunto rotulado (`eval/data/*.jsonl`); `sweep` recalibra thresholds sem chamar modelos.

## Convenções de teste

- Requisitos RF01–RF16 / RNF01–RNF10 estão em `docs/requisitos.md`. Todo teste que cobre um requisito leva o ID no nome (`describe("[RF05] ...")`); `tests/acceptance/test/traceability.test.ts` falha se algum requisito ficar sem teste marcado.
- `tests/acceptance` roda as migrations reais em PGlite com papéis `anon`/`authenticated` simulando o Supabase (`asRole`) — use para testar RLS/trigger.
- Testes não chamam rede nem APIs pagas: pipeline usa deps falsas (`packages/pipeline/test/helpers.ts`), web usa `test/supabaseMock.ts`.

## Infra

Supabase `actually` (sa-east-1) e Vercel `actually` (Root Directory `apps/web`, região gru1). Variáveis em `.env.example` e `apps/web/.env.example`. Operação do dia do debate: `docs/runbook-debate.md`; setup: `docs/setup.md`.
