# actually — live fact-checking for the 2026 Brazilian presidential debate

Listens to a live broadcast, extracts checkable claims, verifies them against a pre-loaded knowledge base and the web, and publishes **short alerts — always with a source**. Priorities, in order: **precision > latency > coverage**. When in doubt, stay silent.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Next.js](https://img.shields.io/badge/Next.js-000?logo=nextdotjs) ![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20pgvector-3FCF8E?logo=supabase&logoColor=white) ![Anthropic](https://img.shields.io/badge/LLM-Anthropic-D97757) ![tests](https://img.shields.io/badge/tests-839%20vitest-brightgreen)

- **Capture agent** runs outside serverless (a 2-hour stream doesn't fit a function): audio → Deepgram streaming STT with diarization → short segments over HTTP, remotely started/stopped from the admin panel.
- **Pipeline** (`packages/pipeline`): filter → claim extraction → repetition lock → parallel retrieval — L1 published fact-checks, L2 official indicator series (BCB, IBGE) compared numerically in code, L3 documents with hybrid search (HNSW vector + full-text fused by RRF), L4 live web search restricted to tier 1–2 domains with a confidence penalty → verification → citation → score.
- **Guarantees in the database**: Postgres trigger + RLS make it impossible to publish a correction without a verified source; alerts are append-only.
- **Human in the loop**: editors approve or reject alerts in `/editor`, with criteria for switching approval on/off during the event.
- **Evaluation**: labeled set measuring red/yellow precision, false-alarm rate, silence rate, per-speaker neutrality and p50/p95 latency; threshold sweep without calling models.

Full architecture (with diagram) in [docs/arquitetura.md](docs/arquitetura.md). Documentation below is in Portuguese.

---

## Estrutura

| Caminho | O que é |
|---|---|
| `apps/web` | Next.js na Vercel: `/ao-vivo`, `/editor`, `/admin`, `/metodologia`, API de ingestão |
| `apps/capture` | CLI que captura áudio (YouTube, dispositivo local ou arquivo), transcreve e envia para a API |
| `apps/kb-ingest` | Cargas da base de conhecimento (checagens, indicadores, documentos) |
| `packages/db` | Tipos, contratos HTTP, cliente Supabase, tiers de fontes |
| `packages/pipeline` | Filtro → extração → trava de repetição → retrieval L1–L4 → verificação → score → publicação |
| `supabase/migrations` | Schema, RLS e garantias (correção sem fonte verificada não publica) |
| `eval` | Conjunto rotulado e avaliação de precisão e latência |
| `docs` | Arquitetura, HITL, atribuição, metodologia, fontes e runbook |

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/arquitetura.md](docs/arquitetura.md) | Visão geral, diagrama, fluxo por segmento, camadas L1–L4, garantias no banco, entrega, decisões |
| [docs/requisitos.md](docs/requisitos.md) | Requisitos RF/RNF com critérios de aceite e testes |
| [docs/human-in-the-loop.md](docs/human-in-the-loop.md) | Aprovação humana dos alertas e critérios para ligar/desligar no dia 23 |
| [docs/atribuicao.md](docs/atribuicao.md) | Quem disse: opção atual e alternativa com HITL de atribuição |
| [docs/metodologia.md](docs/metodologia.md) | Texto-base da página pública `/metodologia` |
| [docs/fontes.md](docs/fontes.md) | Catálogo das fontes e cargas da base (inclui Apify) |
| [docs/setup.md](docs/setup.md) | Supabase, Vercel, chaves, editores com 2FA, base, máquinas de captura |
| [docs/runbook-debate.md](docs/runbook-debate.md) | Cronograma e checklist do dia, failover, incidentes |
| [eval/README.md](eval/README.md) | Conjunto rotulado, métricas, calibração de thresholds e latência |

## Começando

```bash
pnpm install
cp .env.example .env   # preencher chaves
pnpm typecheck
pnpm test
```
