# Fontes e cargas da base de conhecimento

Catálogo do que o sistema consulta, por camada. As cargas são feitas pelo `apps/kb-ingest`, pela CLI
(`pnpm --filter @actually/kb-ingest start -- <comando>`) ou pelo painel *Base de conhecimento* do /admin,
em rodadas curtas na Vercel.

A maior parte entra **antes** do debate, mas a base também cresce **durante**: depois de publicar os
alertas de cada trecho, o pipeline grava na fila `kb_web_finds` as páginas de nível 1–2 que a busca web
(L4) trouxe, e a etapa `web-finds` as transforma em checagem L1 (agência com selo) ou documento L3 —
valendo para as falas seguintes.

> **Códigos de séries, URLs exatas, seletores e listas de feeds ficam no código do `apps/kb-ingest`** (ex.: `src/indicators/catalog.ts`), que é a fonte da verdade. Este documento descreve o que entra e por quê; não duplique códigos aqui.

O nível de confiabilidade de cada domínio (tier 1–4) está em `packages/db/src/tiers.ts` (`SOURCE_TIERS`), sincronizado com a tabela `source_tiers` por `kb-ingest tiers`, e reproduzido em [metodologia.md](metodologia.md#fontes-e-níveis-de-confiabilidade).

## L1 — Checagens publicadas (`kb_factchecks`)

Checagens profissionais já publicadas, com veredito normalizado (`contradito | impreciso | confirmado | inconclusivo`) a partir da classificação original da agência, e o trecho que sustenta o veredito.

| Fonte | Como entra | Observações |
|---|---|---|
| **Google Fact Check Tools API** (`claims:search`, idioma pt) | Consulta por pessoas (Lula, Flávio Bolsonaro) e tópicos-guia | Agrega ClaimReview de várias agências. Requer `GOOGLE_FACTCHECK_API_KEY`. |
| Agência Lupa | RSS / páginas | tier 1 |
| Aos Fatos | RSS / páginas | tier 1 |
| Estadão Verifica | RSS / páginas | tier 1 |
| Fato ou Fake (g1) | páginas | tier 1 |
| Projeto Comprova | RSS / páginas | tier 1 |
| UOL Confere | páginas | tier 1 |
| AFP Checamos | RSS / páginas | tier 1 |
| Agências **sem RSS utilizável** | **Apify** `apify-crawl` (Website Content Crawler) | Ver [Apify](#apify-na-construção-da-base). |

Prioridade de carga: (1) **checagens publicadas sobre o debate de 18/10**; (2) checagens sobre falas dos dois candidatos em 2025–2026; (3) checagens dos tópicos-guia; (4) checagens dos debates de 2022.

Filtro: só checagens que mencionam os candidatos ou os tópicos-guia. Robots.txt respeitado; sem contornar paywall.

## L2 — Indicadores oficiais (`indicator_series`, `indicator_values`)

Séries numéricas consultadas por SQL. A comparação com o número dito é feita **em código** (tolerância de arredondamento), e a evidência é gerada deterministicamente com a URL da série — sem modelo no meio. Cada série tem **aliases** (ex.: “desemprego” = “desocupação”).

| Fonte | Séries (exemplos) | Acesso |
|---|---|---|
| **Banco Central — SGS** | IPCA (mensal e 12 meses), Selic meta, câmbio, dívida líquida e bruta (% PIB), resultado primário | API SGS (JSON) |
| **IBGE — SIDRA** | PNAD Contínua (desocupação: trimestre civil e móvel), PIB (variação, corrente, per capita) | API SIDRA |
| **INPE — TerraBrasilis** | Desmatamento PRODES (anual) e DETER (alertas) na Amazônia e Cerrado | downloads/API TerraBrasilis |
| Salário mínimo | Valores nominais por ano (legislação no Planalto / séries do BCB) | SGS / legislação |
| **Fórum Brasileiro de Segurança Pública / Atlas da Violência (Ipea)** | Homicídios, mortes violentas intencionais | tabelas anuais publicadas |
| **ANP** | Preço médio de combustíveis | séries publicadas |
| **Bolsa Família** (Portal da Transparência / MDS) | Famílias beneficiárias, valor médio | Portal da Transparência |

Cada valor guarda o período (`period_start`, `period_end`) e, quando há, a data de divulgação (`released_at`) — para não comparar uma afirmação com um dado que ainda não existia.

## L3 — Documentos (`kb_documents`, `kb_chunks`)

Textos longos, divididos em trechos com embeddings (Voyage) e índice de texto, buscados de forma híbrida.

| Tipo (`doc_type`) | Fonte | Como entra |
|---|---|---|
| `debate` | **Debate de 18/10/2026** (referência principal e origem do conjunto de teste) | `kb-ingest transcribe` a partir do vídeo/áudio |
| `debate` | Debates presidenciais de 2022 | transcrição de vídeo (`kb-ingest transcribe` ou `apify-youtube`) |
| `programa` | Programas de governo registrados no TSE (DivulgaCandContas) | PDF → texto |
| `noticia` / `outro` | Sites de campanha (propostas, biografias) | **Apify** `apify-crawl` (tier 3: só prova o que foi dito/proposto) |
| `entrevista` | Entrevistas isoladas dos candidatos (TV, rádio, podcasts, YouTube) | **Apify** `apify-youtube` (transcrições) ou transcrição em lote |
| `votacao` / `discurso` | Histórico parlamentar do Flávio Bolsonaro: votações nominais e discursos | **Dados abertos do Senado** (API) |
| `lei` | Atos do governo e legislação citada com frequência | Planalto (legislação) |

`person` identifica de quem é o documento (permite filtrar “o que X disse/votou”).

## L4 — Busca web (ao vivo)

- **Tavily**, chamada junto com L1–L3; o resultado só entra quando a base não traz evidência forte.
- **Desligável por debate** no /admin → Debates → Configurações (“Busca na web”). Desligada, a base é a única fonte e nada vai para `kb_web_finds`. Sem `TAVILY_API_KEY` no servidor, fica desligada em todos os debates.
- `include_domains` = domínios **tier 1 e 2** de `SOURCE_TIERS` (`webSearchDomains()`); resultados de outros domínios são descartados.
- A evidência web paga `web_penalty` no threshold (menos a checagem de agência nível 1 com citação verificada) e passa pela mesma conferência de citação (o trecho precisa existir na página baixada).

## Apify na construção da base

O Apify entra **só na carga prévia** (nunca no caminho ao vivo), via `apify-client` com `APIFY_TOKEN`:

| Comando | Actor | Uso |
|---|---|---|
| `kb-ingest apify-crawl` | Website Content Crawler | Agências de checagem sem RSS utilizável (→ L1) e sites de campanha (→ L3). Respeita robots.txt; limite de páginas e profundidade por site. |
| `kb-ingest apify-youtube` | Transcrições do YouTube | Entrevistas e debates (→ L3, `entrevista`/`debate`). Legenda automática tem erros: preferir `transcribe` (Deepgram) quando o trecho for virar item do eval. |
| `kb-ingest apify-search` (opcional) | Busca no Google | Descobrir URLs de entrevistas/checagens para alimentar os comandos acima. Não gera evidência por si. |

Tudo que vem do Apify passa pelos mesmos filtros: tier pelo domínio, deduplicação por URL, e o texto armazenado é o usado na conferência de citação.

## Tópicos-guia

Usados para priorizar cargas, consultas ao Google Fact Check, `topic` das afirmações e recortes do eval:

| Tópico | Exemplos de afirmações |
|---|---|
| `economia` | inflação, juros, PIB, desemprego, dólar, dívida pública, contas públicas |
| `impostos` | imposto de renda (faixa de isenção), reforma tributária, carga tributária |
| `programas-sociais` | Bolsa Família, salário mínimo, Minha Casa Minha Vida, Farmácia Popular |
| `seguranca` | homicídios, armas, facções, presídios |
| `corrupcao-justica` | processos, STF, 8 de janeiro, Lava Jato |
| `saude` | SUS, vacinas, filas, Mais Médicos |
| `meio-ambiente` | desmatamento (PRODES/DETER), queimadas, COP30 |
| `educacao` | alfabetização, ensino médio, universidades, Pé-de-Meia |
| `politica-externa` | comércio exterior, tarifas, relações internacionais, BRICS |

## Status da carga

`pnpm --filter @actually/kb-ingest start -- status` mostra contagens por camada, fonte e data da última carga. Conferir no T-24h e no T-2h do [runbook](runbook-debate.md).
