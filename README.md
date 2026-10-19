# actually

Checagem de fatos ao vivo para o debate presidencial de 2026. O sistema escuta a transmissão, extrai afirmações checáveis, verifica contra uma base pré-carregada e a web, e emite **alertas curtos, sempre com fonte**.

Prioridades: **precisão > latência > cobertura**. Na dúvida, silêncio.

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
