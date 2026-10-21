# kb-ingest — cargas da base de conhecimento

CLI que carrega as camadas L1 (checagens), L2 (indicadores oficiais) e L3 (documentos) no Supabase.
Todos os comandos são **idempotentes** (upsert por chave natural) e aceitam `--dry-run`, que não grava
nada e imprime o que seria gravado.

```bash
pnpm --filter @actually/kb-ingest start -- <comando> [opções]
pnpm --filter @actually/kb-ingest start -- --help
```

## Variáveis de ambiente

| Variável | Para quê | Obrigatória |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` (ou `SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` | gravar no banco | sim, exceto em `--dry-run`, `indicators --list/--check` |
| `VOYAGE_API_KEY` | embeddings (voyage-3.5, 1024 dim.) | não: sem ela os embeddings ficam nulos; rode `embed-missing` depois |
| `GOOGLE_FACTCHECK_API_KEY` | `factchecks --source google` | só para o Google |
| `DEEPGRAM_API_KEY` | `transcribe` | só para transcrever |
| `APIFY_TOKEN` | `apify-*` | só para Apify |
| `APIFY_MAX_CHARGE_USD` | teto de custo por execução de Actor (padrão 5) | não |
| `TAVILY_API_KEY` | ler pela Tavily a página que recusa o download direto (403, 5xx, timeout) e buscar as checagens recentes das agências (preset `checagens-agencias`) | não: sem ela essas páginas ficam de fora |
| `KB_INGEST_CONTACT` | contato acrescentado ao User-Agent (ex.: URL do projeto) | recomendado |
| `KB_INGEST_MAX_PER_HOST`, `KB_INGEST_MIN_INTERVAL_MS` | concorrência por host (padrão 2) e intervalo mínimo (400 ms) | não |
| `NODE_USE_ENV_PROXY=1` | só se a máquina sai por proxy HTTP(S) (o `fetch` do Node ignora `HTTPS_PROXY` sem isso) | não |

As páginas (checagens, documentos, feeds) respeitam `robots.txt` (inclusive `Crawl-delay`); APIs
documentadas (BCB, IBGE, Senado, Google, Voyage, Deepgram, Tavily) não passam pelo robots. Página HTML cujo
download direto é recusado por HTTP/rede (UOL Confere e AFP Checamos respondem 403 "Access Denied" para a
Vercel) é lida pela Tavily (`src/lib/tavily.ts`, 0,2 crédito por página lida) com a mesma limpeza do HTML;
**robots.txt proibindo nunca cai na Tavily** (o descarte fica, contado como `robots_txt`), nem página 404/410.

## Pelo /admin (sem a sua máquina)

As mesmas cargas rodam na Vercel pela seção *Base de conhecimento* do /admin (`src/jobs/`):

- cada pedido vira uma tarefa em `kb_jobs` com uma fila de etapas curtas (`src/jobs/presets.ts`): uma série por
  etapa, uma consulta do Google por etapa, páginas de checagem em lotes, o Senado por ano, o Apify em
  iniciar → aguardar → ler resultados;
- cada etapa respeita um prazo (`src/jobs/steps.ts`) e o que não couber volta para o início da fila;
  `src/jobs/runner.ts` grava o progresso depois de cada etapa e segura um lease para rodar uma tarefa por vez;
- se a função cair no meio, a etapa em andamento é repetida na próxima rodada (na 3ª queda é dada como falha);
- os manifestos `sources/apify.yaml`, `sources/feeds.yaml` e as séries manuais `sources/manual/*.yaml` vão embutidos em `src/generated/sources.ts`
  (a função não lê o disco): depois de editar os YAML, rode `pnpm --filter @actually/kb-ingest gen:sources`
  (`test/jobs.test.ts` falha se esquecer);
- vídeo do YouTube sem `youtube.input` no manifesto: o input do Actor sai do schema publicado por ele
  (campo de URLs reconhecido; sem campo reconhecível, a etapa falha antes de cobrar);
- **capturas da web** (preset `capturas-web`, criado pela checagem ao vivo; também no fim da atualização diária):
  a etapa `web-finds` pega até 10 páginas da fila `kb_web_finds` (`kb_web_finds_claim`), que a busca web (L4) trouxe
  durante as checagens, e se repete enquanto a fila devolver páginas. Já na base ⇒ `skipped`/`ja_na_base`; texto
  limpo com menos de 500 caracteres ou sem nenhum acento ⇒ `skipped`; página de agência com selo e no tema ⇒
  checagem L1; o resto ⇒ documento L3. As duas com `origin = 'web'`; erro numa página ⇒ `failed` e a fila segue;
  página que não coube no prazo volta para `pending` na hora (`src/commands/webFinds.ts`);
- **checagens das agências pela Tavily** (preset `checagens-agencias`, padrão: últimos 45 dias): uma busca por
  agência de `SOURCE_TIERS` × consulta (`Lula`, `Flávio Bolsonaro`, `debate`, `sabatina entrevista`; agência que
  divide o host com o jornal leva o nome da seção, ex.: "Fato ou Fake Lula"), 1 crédito cada. Fica só página de
  agência (respeita o caminho: `g1.globo.com/fato-ou-fake`, `noticias.uol.com.br/confere`) com data desde o início
  pedido (sem data fica); o texto da busca é a página — nada é baixado de novo (`src/factchecks/agencySearch.ts`).

## Ordem recomendada de carga (dia do ensaio e véspera do debate)

1. `tiers` — sincroniza `SOURCE_TIERS` → `source_tiers` (segundos).
2. `indicators --check` — **sem gravar**: imprime os 6 últimos valores de cada série e confere a desocupação
   móvel × trimestral e, nas séries com reserva, principal × reserva (SIDRA 6381 × SGS 24369). Compare 2–3 valores
   com a página pública da série antes de seguir.
3. `indicators` — grava séries e valores desde 2003 (alguns minutos; séries diárias vão em janelas de 3 anos).
4. `factchecks --since 2025-01-01` — Google Fact Check Tools + feeds das agências. Antes, uma vez:
   `factchecks --verify-feeds` para ver quais feeds as agências anunciam.
5. `senado` (e `senado --discursos`, mais demorado) — votações nominais de Flávio Bolsonaro desde 02/2019.
6. Debate de ontem: `transcribe --url <link> --out data/transcripts` → revisar o `.txt` → mapear falantes →
   `documents --file data/transcripts/<arquivo>.json --speakers "0=...,1=..." --meta '{...}'`.
   Alternativa mais barata: `apify-youtube` (legendas do YouTube) — ver abaixo.
7. `documents` — manifesto `sources/documents.yaml` (programas de governo etc., quando as URLs forem conferidas).
8. `apify-crawl` / `apify-search` — complemento de L1 onde feeds/Google não cobrem.
9. `embed-missing` — preenche os embeddings que ficaram nulos.
10. `status` — contagens por tabela, fonte, pessoa, tópico e série.

Rodar de novo qualquer passo é seguro: o que já existe é atualizado, não duplicado.

## Comandos

### `tiers`
Upsert de `SOURCE_TIERS` (`packages/db/src/tiers.ts`) em `source_tiers`.

### `factchecks` (L1)
- **Google Fact Check Tools** (`claims:search`, `languageCode=pt`, `maxAgeDays` a partir de `--since`):
  consultas sobre Lula, Flávio Bolsonaro, Jair Bolsonaro, governo e tópicos-guia (`GOOGLE_QUERIES` em
  `src/factchecks/google.ts`; `--query` acrescenta). `--max-pages` (padrão 3 × 100 resultados por consulta).
- **Feeds das agências**: nenhuma URL de feed está fixada (não deu para conferir daqui). O coletor descobre o feed
  na página inicial de cada agência (`<link rel="alternate" type="application/rss+xml">`); feeds conferidos à mão
  podem ser fixados em `sources/feeds.yaml`.
- Para cada checagem: baixa a página, extrai o texto principal (Readability + linkedom) → `body`; lê o
  `ClaimReview` em JSON-LD quando existe (rating e afirmação); escolhe `quote` = **sentença literal** do corpo que
  sustenta o veredito (menção ao rating, pistas de refutação/fonte, números, sobreposição com a afirmação). Sem
  trecho literal, a checagem é descartada.
- Rating → `verdict` pela tabela de `src/factchecks/rating.ts`: Falso/Fake/Montagem ⇒ `contradito`;
  Enganoso/Distorcido/Exagerado/Sem contexto/Impreciso/Verdadeiro, mas/Parcialmente falso/Não é bem assim ⇒
  `impreciso`; Verdadeiro/Fato/Comprovado ⇒ `confirmado`; Insustentável/Contraditório/Sátira/De olho/desconhecido
  ⇒ `inconclusivo`.
- `person` ("Lula", "Flávio Bolsonaro", "Jair Bolsonaro"; "Bolsonaro" sozinho é ambíguo ⇒ nulo) e `topic`
  (economia, impostos, programas_sociais, seguranca, corrupcao_justica, saude, meio_ambiente, educacao,
  politica_externa) por regras em `src/lib/classify.ts`. Sem pessoa nem tópico ⇒ descartada (use `--all-topics`).
- **Matéria de agência com várias falas** ("Checamos o debate da Band", cada fala com seu selo, sem selo único):
  quando a página é de agência (`kind: "checagem"` em `SOURCE_TIERS`), não tem selo/afirmação/trecho único e cita
  pessoa ou tópico-guia, vira **documento L3** (`doc_type=noticia`, tier e nome da agência) em vez de descarte
  (`virou_documento` no log). Documento que já existe com a mesma URL não é sobrescrito (`ja_na_base`).
- Já gravadas — como checagem ou como documento — são puladas (`--refresh` reprocessa). Embedding = `claim_text`.

### `indicators` (L2)
Catálogo em `src/indicators/catalog.ts` (code, name, aliases, unit, periodicity, aggregation, source_name, source_url,
tier, notes e a origem de cada código). `--list` mostra ativas e pendentes; `--only a,b`; `--since`; `--check`;
`--include-pending`.

`aggregation` diz ao comparador L2 como ler um período mais longo que a série: `sum` (fluxo: Caged, PIB nominal —
ano = soma), `mean_or_last` (taxa: média ou último ponto), `last` (estoque: fim do período), `accum_12m` (ano civil =
dezembro) ou `none` (só o período exato). Série anual de taxa (PIB anual, carga tributária) é `mean_or_last`: "cresceu
X% ao ano entre 2003 e 2010" é a média das taxas anuais (2003–2010 ≈ 4,1%). **Hoje a L2 ainda não compara nível com
intervalo** (`2003..2010` ⇒ `nivel_com_intervalo`, silêncio), então para série anual `none` e `mean_or_last` se
comportam igual; a declaração deixa a série pronta para quando o pipeline aceitar intervalos. Alias genérico repetido
em duas séries só se uma delas não couber na afirmação (ver o cabeçalho do catálogo: pares do IPCA e do PIB); na
dúvida o pipeline cala a L2.

**Reserva (`fallback`)**: o mesmo dado por outra porta, usada só se a principal falhar ou vier vazia (o log da carga
avisa). Precisa gerar os mesmos `period_start/period_end`. Hoje só a desocupação móvel tem: SIDRA 6381 (IBGE, quem
produz; a evidência abre a tabela) e, de reserva, SGS 24369 (o BCB espelha).

**SGS devolvendo HTML**: às vezes a API do BCB responde 200 com uma página XHTML no lugar do JSON e acerta na tentativa
seguinte. `fetchSgs` repete até 2 vezes (esperas de ~2 s e ~4 s), cada repetição sem as repetições de rede e com teto
de 20 s, para não multiplicar o tempo de uma etapa do /admin.

**Séries manuais** (`fetch: { kind: "manual" }`): fonte sem API nem arquivo estável. Os valores ficam em
`sources/manual/<arquivo>.yaml`, um por período, cada um com `url` da publicação, `source`, `verified_by` e
`released_at`. O carregador (`src/indicators/manual.ts`) recusa o arquivo inteiro se um valor não tiver URL de nível 1
— ou de nível 2 com `confirmed_by` de outro veículo de nível 2 —, repetir período ou trocar série/unidade. Depois de
editar, `pnpm --filter @actually/kb-ingest gen:sources` (a Vercel lê a cópia embutida).

**Ordem obrigatória:** aplicar `supabase/migrations/20261019000007_indicator_aggregation.sql` (cria a coluna
`indicator_series.aggregation` e o `find_indicator` que a devolve) e **depois** rodar `indicators`. Sem a migration a
carga para no primeiro upsert, com o nome do arquivo no erro. Entre a migration e a nova carga, as séries antigas ficam
com `aggregation` nula e o pipeline cala a L2 nelas (`serie_sem_agregacao`); `status` mostra essas séries como
`SEM AGREGAÇÃO` e as que divergem do catálogo (agregação ou aliases antigos) como `DESATUALIZADA`.

Períodos: mensal → mês; trimestral → trimestre civil; trimestre móvel → 3 meses terminando no mês de referência;
anual → ano. Séries diárias do SGS (Selic meta, dólar) viram o **último valor de cada mês**.

| Série | Fonte | Situação |
|---|---|---|
| ipca_mensal / ipca_12m | SGS 433 / 13522 | ativa |
| selic_meta | SGS 432 (diária → fim do mês) | ativa |
| dolar_venda | SGS 1 (diária → fim do mês) | ativa |
| dlsp_pib / dlgg_pib | SGS 4513 / 4536 | ativa |
| primario_12m_pib | SGS 5793 (NFSP: positivo = déficit) | ativa |
| desocupacao_pnadc_trimestral | SIDRA 4099 v4099 | ativa |
| desocupacao_pnadc_movel | SIDRA 6381 v4099 (reserva: SGS 24369) | ativa (conferida contra a trimestral e a reserva no `--check`) |
| pib_variacao_trimestral / pib_corrente_trimestral | SIDRA 5932 v6561 / 1846 v585 (c11255/90707) | ativa |
| pib_per_capita / populacao_estimada | SIDRA 6784 v9812 / 6579 v9324 | ativa |
| rendimento_medio_real | SIDRA 6387 v5935 (trimestre móvel) | ativa |
| caged_saldo | SGS 28561 | ativa (nome herdado; conferir) |
| dbgg_pib (dívida bruta) | — | **pendente**: código não confirmado |
| pib_variacao_anual | SGS 7326 (taxa de variação real no ano) | ativa (`mean_or_last`) |
| carga_tributaria_pib | manual: `sources/manual/carga_tributaria.yaml` (Tesouro Nacional) | ativa só com 2024–2025 (edição de 10/04/2026); 2010–2023 pendentes |
| desmatamento PRODES, salário mínimo, homicídios, Bolsa Família | — | **pendentes** (ver `--list`) |

O SIDRA é consultado primeiro pela API de Agregados v3 (`servicodados.ibge.gov.br`, `view=flat`) e, se falhar,
pelo `apisidra.ibge.gov.br` (que desde 09/2026 pode responder com desafio anti-robô).

### `documents` (L3)
- Manifesto `sources/documents.yaml` (url, title, doc_type, person, source_name, tier, topics, published_at,
  format). Baixa HTML (Readability) ou PDF (`unpdf`), tier por `lookupSource` (ou explícito), chunking por
  sentenças (~800 tokens, sobreposição ~100, cada chunk é trecho literal do texto), embeddings e upsert em
  `kb_documents`/`kb_chunks`. Corpo igual ao já gravado ⇒ só atualiza metadados; corpo novo ⇒ refaz os chunks.
- Arquivo local: `--file transcricao.txt|.json --meta '{"url":"https://...","title":"...","doc_type":"debate","published_at":"2026-10-18"}'`.
  O `.json` pode ser a saída do `transcribe`, a resposta crua do Deepgram ou `{ "text": ... }`.
  `url` é obrigatória (kb_documents exige http/https): use o link público do vídeo/da fonte.

### `senado`
Acha o código do senador pelo nome em `/senador/lista/atual` (ou `/senador/afastados`) — nada fixado —, busca
`/votacao?codigoParlamentar=…` ano a ano desde `--since` (padrão 2019-02-01) e grava cada votação como documento
`doc_type=votacao`, `person="Flávio Bolsonaro"`, com corpo montado só com campos da fonte (matéria, ementa,
resultado, placar e o voto dele). `--discursos` também baixa o texto integral dos pronunciamentos (`doc_type=discurso`).

### `transcribe`
Deepgram pré-gravado (`nova-3`, `pt-BR`, `diarize`, `smart_format`, `utterances`) de `--file` local ou `--url`.
URL do YouTube: baixa o áudio com `yt-dlp -x` (precisa de `yt-dlp` + `ffmpeg` no PATH). Grava
`data/transcripts/<nome>.json` (falas com falante e tempos) e `.txt` (`[mm:ss] Falante N: ...`). `--speakers
"0=Lula,1=Flávio Bolsonaro"` troca os rótulos **depois de conferir** quem é quem. `--ingest --doc-type
debate|entrevista --person ... --title ... --source-url ... --published-at ...` já grava como documento.

### `embed-missing`
Preenche `embedding` nulo em `kb_chunks` (texto) e `kb_factchecks` (`claim_text`), em lotes de até 64 textos,
com retry/backoff (429/5xx) e pausa entre lotes. `--table`, `--max`.

### `status`
Contagens por tabela; L1 por fonte/veredito/pessoa/tópico; L2 por série (com último período); L3 por
tipo/pessoa/fonte/tópico; embeddings faltando.

## Apify

Manifesto `sources/apify.yaml`. Toda execução tem teto de custo (`APIFY_MAX_CHARGE_USD`, padrão US$ 5) e pode
ser reprocessada sem custo com `--dataset <id>` (dataset de uma execução anterior) ou `--items export.json`.

| Comando | Actor | Saída |
|---|---|---|
| `apify-check --actor <id>` | qualquer | existe? deprecated? preço (`pricingInfos`) e campos de input |
| `apify-crawl [--only job]` | `apify/website-content-crawler` | jobs `factcheck` ⇒ L1 (mesma normalização: rating, `quote` literal, veredito); jobs `document` ⇒ L3 |
| `apify-youtube` | `curious_coder/youtube-transcript-scraper` | legendas/transcrições ⇒ documentos `debate`/`entrevista` |
| `apify-search` | `apify/google-search-scraper` | descobre checagens recentes; só domínios tier 1–2 (`webSearchDomains()`); páginas das agências seguem o caminho do `factchecks` |

**Situação da confirmação:** a Apify Store (`api.apify.com`) estava bloqueada no ambiente em que isto foi escrito.
Os nomes dos Actors vêm do índice do plugin Apify, e os campos de input (`startUrls`, `maxCrawlPages`, `queries`)
da documentação de workflows do mesmo plugin. **Rode `apify-check` para cada Actor antes do primeiro uso** e ajuste
`input` no manifesto. O `input` do Actor de YouTube está vazio de propósito: o comando se recusa a rodar até ele
ser preenchido. A leitura da saída é tolerante a vários nomes de campo (`src/apify/map.ts`, testada).

**Quando usar Apify × coletores diretos**
- Checagens: prefira `factchecks` (Google + feeds; grátis, com ClaimReview). Use `apify-crawl` para agência sem feed
  ou que bloqueia o download direto; `apify-search` para varrer o que saiu nas últimas horas.
- Indicadores e Senado: sempre os coletores diretos (APIs oficiais, sem custo).
- Debate/entrevistas no YouTube: `apify-youtube` é mais rápido e barato (pega a legenda pronta), mas legenda
  automática erra e não separa falantes — por isso entra como tier 4 (nunca sustenta alerta sozinho). Para o
  debate de referência, prefira `transcribe` (Deepgram, com diarização) e revise.

**Custo/limites:** a Store não pôde ser consultada, então não há estimativa confirmada. `apify-check` mostra o
modelo de preço de cada Actor; Actors pay-per-event cobram por resultado. Comece com `max_pages` baixo (o
manifesto usa 150 por agência) e acompanhe no painel da Apify.

## Testes

```bash
pnpm --filter @actually/kb-ingest typecheck
pnpm --filter @actually/kb-ingest test
```

Sem rede. Cobrem: tabela de rating, chunker (trechos literais, limite e sobreposição), divisão em sentenças,
HTML → texto + JSON-LD + escolha do `quote`, parsers SGS (valores reais) e SIDRA/Agregados (formato; 6381 com valores
reais), repetição quando o SGS devolve HTML, principal × reserva da desocupação móvel, PIB anual (7326, valores reais),
série manual da carga tributária e suas regras, resolução de períodos, catálogo, feeds, Google, Senado, Deepgram,
robots.txt, pessoa/tópico e mapeamentos da Apify.
A proveniência dos fixtures está no topo de `test/indicators.test.ts`.
