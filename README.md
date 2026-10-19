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

## Começando

```bash
pnpm install
cp .env.example .env   # preencher chaves
pnpm typecheck
pnpm test
```
