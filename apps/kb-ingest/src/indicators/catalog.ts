// Catálogo das séries oficiais (camada L2).
//
// COMO CADA CÓDIGO FOI CONFERIDO (19/10/2026). Deste ambiente, api.bcb.gov.br,
// apisidra.ibge.gov.br e servicodados.ibge.gov.br estão bloqueados pelo proxy, então
// nenhum código abaixo foi chamado daqui. A conferência veio de:
//  [bcb-portal]  catálogo do pacote npm bcb-br-mcp@1.18.2, "verificado série a série
//                contra a origem em 13/08/2026", nome transcrito do dataset no Portal
//                de Dados Abertos do BCB (fonteNome "portal").
//  [bcb-medido]  mesmo catálogo, série SEM dataset no portal: código e periodicidade
//                medidos na API, nome herdado (fonteNome "medido").
//  [bcb-nb]      valores reais obtidos da API e gravados nos notebooks do pacote
//                python-bcb 0.4.0 (ex.: sgs.get({'IPCA': 433}) → 2020-12 = 1.35).
//  [ibge-v3]     catálogo do pacote npm ibge-br-mcp@5.10.0, "medido contra a API de
//                Agregados em 2026-10-08", uma série por variável/categoria.
// Conferidos em 21/10/2026 (mesmo bloqueio; a API de metadados do IBGE não abriu daqui):
//  [sidra-6381]  tabela 6381, variável 4099, período AAAAMM = último mês do trimestre móvel:
//                (a) github.com/guilhermekleinmartins-creator/indicador-made, fetch_sidra.py
//                chama apisidra .../t/6381/n1/all/v/4099/p/last%2024 (lê o período em D3C) e o
//                data/pnadc.csv que ele atualiza traz 2026-03 = 6,1 e 2026-05 = 5,6, iguais às
//                divulgações do IBGE (Agência IBGE: "No trimestre encerrado em março, desocupação
//                sobe para 6,1%"; "Taxa de desocupação é de 5,6% ... no trimestre encerrado em
//                maio"); (b) github.com/alexandrepsaldanha/monitor-mercado-trabalho (R/coleta.R:
//                6381 = taxa de desocupação, trimestre móvel; variável "Taxa de desocupação, na
//                semana de referência, das pessoas de 14 anos ou mais de idade"; 2012-03 = 8,0,
//                igual ao indicador-made); (c) Análise Macro, get_sidra('/t/6381/n1/all/v/4099/p/all'),
//                e a lista de tabelas da PNAD Contínua mensal no SIDRA, ambos lidos via busca.
//                A 6381 tem outras variáveis (CV, variações): a 4099 tem de ir fixa na consulta.
//  [bcb-7326]    nome "Produto Interno Bruto - Taxa de variação real no ano" (anual, fonte IBGE)
//                no espelho do SGS da Quantilica e na Nota Técnica nº 14 da UFG (via busca);
//                valores reais da API gravados por github.com/rlavourinha/monitor-cobertura
//                (coletar.py: bcb.sgs(7326, ...) → data/realizado.json): 2010 = 7,53,
//                2020 = −3,28, 2023 = 3,24, 2024 = 3,42, 2025 = 2,29 — batem com o IBGE e com o
//                Relatório de Política Monetária do BCB de set/2026 (tabela 1.2.1, via busca).
//  [manual]      valores copiados da publicação oficial para sources/manual/<arquivo>.yaml, com
//                URL e conferência por valor (ver src/indicators/manual.ts).
// Antes do debate: rode `indicators --check` numa máquina com acesso e confira os
// últimos valores contra a página pública de cada série.
//
// Séries com `pending` NÃO são carregadas (só com --include-pending): código ou
// fonte não confirmados. O motivo fica registrado aqui e no relatório.
//
// ALIASES: o pipeline só usa a série se o nome dito casar sem ambiguidade (alias exato,
// ou aproximado alto com margem clara). Um alias genérico repetido em duas séries é
// EMPATE: só se resolve quando apenas uma delas cabe na afirmação (ex.: "inflação de
// 2023" só cabe no acumulado 12m; "inflação de março" cabe nas duas ⇒ silêncio).
// Não ponha em duas séries um alias que as duas respondem do mesmo jeito (desemprego).
// O par do PIB (anual × trimestral) é empate de propósito: o ano só cabe na anual (a trimestral
// tem `none`), o trimestre só na trimestral; sem período, as duas cabem ⇒ silêncio.
//
// SÉRIE ANUAL DE TAXA (PIB anual, carga tributária): `mean_or_last`. "Cresceu X% ao ano entre
// 2003 e 2010" é a média das taxas anuais (média aritmética, a que o comparador calcula;
// 2003–2010 = 4,08, a geométrica dá 4,05); "chegou a X% no fim do governo" é o último ponto.
// `sum` somaria taxas, `last`/`none` não dão média e `accum_12m` é de série mensal. Para série
// anual, `none` e `mean_or_last` se comportam igual na L2 de hoje: ela ainda não compara nível
// com intervalo ("2003..2010" ⇒ nivel_com_intervalo, silêncio). Série anual de nível/contagem
// (população, PIB per capita em R$) fica `none`.
import type { IndicatorAggregation, IndicatorSeries } from "@actually/db";
import { sgsPublicUrl } from "./sgs";
import { sidraPublicUrl } from "./sidra";

export type SeriesFetch =
  | { kind: "sgs"; code: number; daily?: { aggregate: "last" | "mean" } }
  | { kind: "sidra"; table: string; variable: string; classification?: string }
  /** Valores em sources/manual/<file>.yaml (embutido em src/generated/sources.ts). */
  | { kind: "manual"; file: string }
  | { kind: "none" };

/** Fonte de dados de verdade (com API): a que serve de principal ou de reserva. */
export type ApiFetch = Extract<SeriesFetch, { kind: "sgs" | "sidra" }>;

export interface CatalogSeries extends IndicatorSeries {
  /**
   * Como a série se agrega num período mais longo que a sua periodicidade (coluna
   * indicator_series.aggregation; valores e significado em IndicatorAggregation, @actually/db).
   * Obrigatória aqui: no banco, null = não declarada e o pipeline cala a L2 da série.
   */
  aggregation: IndicatorAggregation;
  fetch: SeriesFetch;
  /**
   * Reserva: o MESMO dado por outra porta, usada só se a principal falhar ou vier vazia. Tem de
   * gerar os mesmos period_start/period_end (é o que o upsert e a L2 usam); `indicators --check`
   * carrega as duas e compara.
   */
  fallback?: ApiFetch;
  /** Como o código foi conferido (ver cabeçalho). */
  verified_by: string;
  /** Preenchido quando a série NÃO pode ser carregada ainda. */
  pending?: string;
}

/** Rótulo curto da fonte ("SGS 433", "SIDRA t6381 v4099", "manual carga_tributaria"). */
export function describeFetch(f: SeriesFetch): string {
  switch (f.kind) {
    case "sgs":
      return `SGS ${f.code}`;
    case "sidra":
      return `SIDRA t${f.table} v${f.variable}`;
    case "manual":
      return `manual ${f.file}`;
    case "none":
      return "—";
  }
}

const BCB = "Banco Central do Brasil (SGS)";

export const CATALOG: CatalogSeries[] = [
  // ------------------------------------------------------------------ preços
  {
    code: "ipca_mensal",
    name: "IPCA — variação mensal",
    // "ipca"/"inflação"/"custo de vida" também em ipca_12m (empate de propósito: ver cabeçalho)
    aliases: ["ipca", "inflação", "custo de vida", "índice de preços ao consumidor amplo", "inflação mensal", "inflação do mês", "ipca mensal", "ipca do mês"],
    unit: "%",
    periodicity: "monthly",
    aggregation: "none",
    source_name: "IBGE — IPCA (série 433 do SGS/BCB)",
    source_url: sgsPublicUrl(433),
    tier: 1,
    notes: "Variação % no mês. Para inflação 'do ano' ou 'em 12 meses' use ipca_12m.",
    fetch: { kind: "sgs", code: 433 },
    verified_by: "bcb-medido + bcb-nb",
  },
  {
    code: "ipca_12m",
    name: "IPCA — acumulado em 12 meses",
    // sem "inflação no ano"/"inflação acumulada"/"ipca acumulado": no IBGE isso é o acumulado
    // NO ANO (jan até o mês), outra medida — só coincide com 12 meses em dezembro
    aliases: [
      "ipca", "inflação", "custo de vida", "índice de preços ao consumidor amplo",
      "inflação em 12 meses", "inflação acumulada em 12 meses", "inflação dos últimos 12 meses", "inflação anual",
      "ipca 12 meses", "ipca em 12 meses", "ipca acumulado em 12 meses",
    ],
    unit: "%",
    periodicity: "monthly",
    aggregation: "accum_12m",
    source_name: "IBGE — IPCA (série 13522 do SGS/BCB)",
    source_url: sgsPublicUrl(13522),
    tier: 1,
    notes: "Variação acumulada nos 12 meses terminados no mês de referência. A inflação de um ano civil é o valor de dezembro.",
    fetch: { kind: "sgs", code: 13522 },
    verified_by: "bcb-medido",
  },
  // ------------------------------------------------------------------ juros e câmbio
  {
    code: "selic_meta",
    name: "Taxa Selic — meta definida pelo Copom",
    aliases: ["selic", "juros", "taxa de juros", "taxa básica de juros", "juros básicos", "meta selic"],
    unit: "% a.a.",
    periodicity: "monthly",
    aggregation: "mean_or_last",
    source_name: "Banco Central do Brasil — Meta Selic (série 432 do SGS)",
    source_url: sgsPublicUrl(432),
    tier: 1,
    notes: "Série diária no SGS; guardamos a meta vigente no último dia com dado de cada mês.",
    fetch: { kind: "sgs", code: 432, daily: { aggregate: "last" } },
    verified_by: "bcb-portal",
  },
  {
    code: "dolar_venda",
    name: "Dólar comercial (câmbio livre) — venda",
    aliases: ["dólar", "câmbio", "cotação do dólar", "taxa de câmbio", "real frente ao dólar"],
    unit: "R$/US$",
    periodicity: "monthly",
    aggregation: "mean_or_last",
    source_name: "Banco Central do Brasil — câmbio livre, dólar venda (série 1 do SGS)",
    source_url: sgsPublicUrl(1),
    tier: 1,
    notes: "Série diária no SGS; guardamos a cotação do último dia útil de cada mês.",
    fetch: { kind: "sgs", code: 1, daily: { aggregate: "last" } },
    verified_by: "bcb-portal + bcb-nb",
  },
  // ------------------------------------------------------------------ fiscal
  {
    code: "dlsp_pib",
    name: "Dívida líquida do setor público consolidado (% do PIB)",
    aliases: ["dívida líquida", "dívida pública líquida", "dlsp", "dívida do setor público"],
    unit: "% do PIB",
    periodicity: "monthly",
    aggregation: "last",
    source_name: "Banco Central do Brasil — DLSP % PIB (série 4513 do SGS)",
    source_url: sgsPublicUrl(4513),
    tier: 1,
    notes: "Setor público consolidado. Não confundir com dívida BRUTA do governo geral (dbgg_pib, pendente).",
    fetch: { kind: "sgs", code: 4513 },
    verified_by: "bcb-portal",
  },
  {
    code: "dlgg_pib",
    name: "Dívida líquida do governo geral (% do PIB)",
    aliases: ["dívida líquida do governo geral", "dívida do governo"],
    unit: "% do PIB",
    periodicity: "monthly",
    aggregation: "last",
    source_name: "Banco Central do Brasil — dívida líquida do governo geral % PIB (série 4536 do SGS)",
    source_url: sgsPublicUrl(4536),
    tier: 1,
    notes: null,
    fetch: { kind: "sgs", code: 4536 },
    verified_by: "bcb-portal",
  },
  {
    code: "primario_12m_pib",
    name: "Resultado primário do setor público consolidado — acumulado em 12 meses (% do PIB, NFSP)",
    aliases: ["resultado primário", "déficit primário", "superávit primário", "rombo das contas públicas", "déficit fiscal", "contas públicas"],
    unit: "% do PIB",
    periodicity: "monthly",
    aggregation: "accum_12m",
    source_name: "Banco Central do Brasil — NFSP primário 12 meses % PIB (série 5793 do SGS)",
    source_url: sgsPublicUrl(5793),
    tier: 1,
    notes:
      "Necessidades de financiamento (NFSP) sem desvalorização cambial: valor POSITIVO = déficit primário; NEGATIVO = superávit. " +
      "Ao comparar com 'déficit de X% do PIB', compare com o valor como está.",
    fetch: { kind: "sgs", code: 5793 },
    verified_by: "bcb-portal",
  },
  {
    code: "dbgg_pib",
    name: "Dívida bruta do governo geral (% do PIB) — metodologia a partir de 2008",
    aliases: ["dívida bruta", "dívida pública", "dívida pública bruta", "dbgg", "dívida/pib"],
    unit: "% do PIB",
    periodicity: "monthly",
    aggregation: "last",
    source_name: BCB,
    source_url: "https://dadosabertos.bcb.gov.br/",
    tier: 1,
    notes: "Indicador mais citado em debate sobre dívida.",
    fetch: { kind: "none" },
    verified_by: "—",
    pending:
      "código SGS não confirmado: o catálogo verificado só traz a 4537 (metodologia até 2007). " +
      "Confirme no Portal de Dados Abertos (package_search?q=codigo_sgs:N) e preencha fetch.",
  },
  // ------------------------------------------------------------------ atividade e trabalho
  {
    code: "desocupacao_pnadc_trimestral",
    name: "Taxa de desocupação — PNAD Contínua (trimestre civil)",
    // os aliases genéricos ("desemprego", "taxa de desemprego", "desocupação") ficam só na
    // série móvel, que responde por mês, trimestre civil, ano e dado atual: repetidos aqui
    // seriam um empate sem desempate e a L2 ficaria em silêncio no indicador mais citado.
    // Sem "desempregados": é contagem de pessoas, não a taxa ("8,5 milhões de desempregados"
    // com a escala perdida na extração viraria 8,5 comparado como %)
    aliases: ["desemprego trimestral", "desemprego no trimestre", "taxa de desocupação trimestral", "desocupação trimestral"],
    unit: "%",
    periodicity: "quarterly",
    aggregation: "mean_or_last",
    source_name: "IBGE — PNAD Contínua, tabela 4099",
    source_url: sidraPublicUrl("4099"),
    tier: 1,
    notes: "Pessoas de 14 anos ou mais. Trimestres civis (jan-mar, abr-jun, jul-set, out-dez).",
    fetch: { kind: "sidra", table: "4099", variable: "4099" },
    verified_by: "ibge-v3",
  },
  {
    // PRINCIPAL = SIDRA 6381 (IBGE, quem produz o dado); RESERVA = SGS 24369 (o BCB espelha a
    // mesma taxa). Por quê: o SGS devolveu HTML nas duas cargas de 10/2026 enquanto as tabelas
    // do SIDRA (4099, 6387) carregaram; a 24369 é "bcb-medido" (nome herdado, sem dataset no
    // portal), a 6381 foi conferida com valores do IBGE; a evidência aponta para a tabela do
    // IBGE, que o leitor abre, e não para o JSON do SGS; e a conferência móvel × trimestral
    // fica IBGE × IBGE. As duas geram os mesmos períodos (SIDRA 202603 e SGS 01/03/2026 ⇒
    // 2026-01-01..2026-03-31), então trocar de porta não muda o upsert nem a L2.
    code: "desocupacao_pnadc_movel",
    name: "Taxa de desocupação — PNAD Contínua (trimestre móvel)",
    aliases: ["desemprego", "taxa de desemprego", "desocupação", "taxa de desocupação", "desemprego atual", "menor desemprego", "desemprego mensal"],
    unit: "%",
    periodicity: "moving_quarter",
    aggregation: "mean_or_last",
    source_name: "IBGE — PNAD Contínua, tabela 6381",
    source_url: sidraPublicUrl("6381"),
    tier: 1,
    notes:
      "Divulgação mensal do IBGE, cada ponto é um trimestre móvel rotulado pelo último mês (SIDRA 202607 = mai-jun-jul/2026). " +
      "Reserva: série 24369 do SGS/BCB (mesmo dado). `indicators --check` compara as duas e os pontos de mar/jun/set/dez " +
      "com a série trimestral (4099).",
    fetch: { kind: "sidra", table: "6381", variable: "4099" },
    fallback: { kind: "sgs", code: 24369 },
    verified_by: "sidra-6381 (principal) + bcb-medido (reserva 24369)",
  },
  {
    code: "pib_variacao_trimestral",
    name: "PIB — variação em volume no trimestre contra o mesmo trimestre do ano anterior",
    aliases: ["pib", "crescimento do pib", "crescimento da economia", "variação do pib", "pib trimestral"],
    unit: "%",
    periodicity: "quarterly",
    aggregation: "none",
    source_name: "IBGE — Contas Nacionais Trimestrais, tabela 5932",
    source_url: sidraPublicUrl("5932"),
    tier: 1,
    notes: "PIB a preços de mercado (c11255/90707). Não é o crescimento do ano: esse é pib_variacao_anual.",
    fetch: { kind: "sidra", table: "5932", variable: "6561", classification: "c11255/90707" },
    verified_by: "ibge-v3",
  },
  {
    code: "pib_corrente_trimestral",
    name: "PIB a preços correntes (trimestral)",
    aliases: ["tamanho do pib", "pib em reais", "valor do pib"],
    unit: "R$ milhões",
    periodicity: "quarterly",
    aggregation: "sum",
    source_name: "IBGE — Contas Nacionais Trimestrais, tabela 1846",
    source_url: sidraPublicUrl("1846"),
    tier: 1,
    notes: null,
    fetch: { kind: "sidra", table: "1846", variable: "585", classification: "c11255/90707" },
    verified_by: "ibge-v3",
  },
  {
    code: "pib_per_capita",
    name: "PIB per capita (preços correntes)",
    aliases: ["pib per capita", "renda per capita"],
    unit: "R$",
    periodicity: "annual",
    aggregation: "none",
    source_name: "IBGE — Contas Nacionais Anuais, tabela 6784",
    source_url: sidraPublicUrl("6784"),
    tier: 1,
    notes: null,
    fetch: { kind: "sidra", table: "6784", variable: "9812" },
    verified_by: "ibge-v3",
  },
  {
    // SGS 7326 (o BCB espelha a taxa anual das Contas Nacionais do IBGE). As variáveis do SIDRA
    // (5932 "acumulada em quatro trimestres", 6784 "variação em volume") NÃO foram confirmadas.
    // Aliases genéricos do PIB repetidos na trimestral de propósito (ver cabeçalho).
    code: "pib_variacao_anual",
    name: "PIB — taxa de variação real no ano",
    aliases: [
      "pib", "crescimento do pib", "crescimento da economia", "variação do pib",
      "crescimento do pib no ano", "pib cresceu", "pib anual", "crescimento anual do pib",
    ],
    unit: "%",
    periodicity: "annual",
    aggregation: "mean_or_last",
    source_name: "IBGE — Contas Nacionais (série 7326 do SGS/BCB)",
    source_url: sgsPublicUrl(7326),
    tier: 1,
    notes:
      "Variação real (em volume) do PIB no ano civil, em %. Média de vários anos = média das taxas anuais " +
      "(2003–2010 ≈ 4,1% ao ano). O IBGE revisa os anos recentes: o valor guardado é o da última carga.",
    fetch: { kind: "sgs", code: 7326 },
    verified_by: "bcb-7326",
  },
  {
    code: "rendimento_medio_real",
    name: "Rendimento médio real efetivo de todos os trabalhos — PNAD Contínua (trimestre móvel)",
    aliases: ["renda", "renda do trabalhador", "salário médio", "rendimento médio", "renda média"],
    unit: "R$",
    periodicity: "moving_quarter",
    aggregation: "mean_or_last",
    source_name: "IBGE — PNAD Contínua, tabela 6387",
    source_url: sidraPublicUrl("6387"),
    tier: 1,
    notes: "Valores reais (deflacionados) — o IBGE reprocessa a série a cada divulgação.",
    fetch: { kind: "sidra", table: "6387", variable: "5935" },
    verified_by: "ibge-v3",
  },
  {
    code: "populacao_estimada",
    name: "População residente estimada",
    aliases: ["população", "habitantes", "brasileiros"],
    unit: "pessoas",
    periodicity: "annual",
    aggregation: "none",
    source_name: "IBGE — Estimativas de População, tabela 6579",
    source_url: sidraPublicUrl("6579"),
    tier: 1,
    notes: null,
    fetch: { kind: "sidra", table: "6579", variable: "9324" },
    verified_by: "ibge-v3",
  },
  {
    code: "caged_saldo",
    name: "Novo Caged — saldo de empregos formais no mês",
    aliases: ["empregos formais", "carteira assinada", "geração de empregos", "vagas criadas", "caged"],
    unit: "postos de trabalho",
    periodicity: "monthly",
    aggregation: "sum",
    source_name: "Ministério do Trabalho — Caged (série 28561 do SGS/BCB)",
    source_url: sgsPublicUrl(28561),
    tier: 1,
    notes: "Nome herdado no catálogo de referência (série sem dataset no portal do BCB): confira o último valor com o MTE antes de usar.",
    fetch: { kind: "sgs", code: 28561 },
    verified_by: "bcb-medido",
  },
  // ------------------------------------------------------------------ impostos
  {
    // Sem API: o Tesouro publica um boletim anual (PDF) e a planilha "Base CTB GG.xlsx" no
    // Tesouro Transparente. Valores conferidos, um a um, em sources/manual/carga_tributaria.yaml.
    // A Receita Federal publica outra estimativa ("Carga Tributária no Brasil"), com metodologia
    // própria: não misture as duas na mesma série.
    code: "carga_tributaria_pib",
    name: "Carga tributária bruta do governo geral (% do PIB)",
    aliases: ["carga tributária", "carga tributária bruta", "impostos em relação ao pib", "peso dos impostos", "carga de impostos"],
    unit: "% do PIB",
    periodicity: "annual",
    aggregation: "mean_or_last",
    source_name: "Tesouro Nacional — Estimativa da Carga Tributária Bruta do Governo Geral",
    source_url: "https://www.tesourotransparente.gov.br/publicacoes/carga-tributaria-do-governo-geral/2025/114",
    tier: 1,
    notes:
      "Governo geral (União, estados e municípios), metodologia do manual de finanças públicas do FMI (2014). " +
      "O Tesouro revisa a série inteira a cada boletim (na revisão metodológica, FGTS e Sistema S deixaram de contar " +
      "como tributo): só valores da edição mais recente. A Receita Federal publica outra estimativa, com outra metodologia.",
    fetch: { kind: "manual", file: "carga_tributaria" },
    verified_by: "manual (sources/manual/carga_tributaria.yaml: URL e conferência por valor)",
  },
  // ------------------------------------------------------------------ pendentes (outros tópicos)
  {
    code: "desmatamento_prodes_amazonia",
    name: "Desmatamento na Amazônia Legal — PRODES (taxa anual)",
    aliases: ["desmatamento", "desmatamento na amazônia", "prodes", "área desmatada"],
    unit: "km²",
    periodicity: "annual",
    aggregation: "none",
    source_name: "INPE — PRODES (TerraBrasilis)",
    source_url: "https://terrabrasilis.dpi.inpe.br/",
    tier: 1,
    notes: "Ano PRODES vai de agosto a julho.",
    fetch: { kind: "none" },
    verified_by: "—",
    pending: "terrabrasilis.dpi.inpe.br bloqueado neste ambiente; endpoint de dados (API/CSV) não confirmado.",
  },
  {
    code: "salario_minimo",
    name: "Salário mínimo nominal",
    aliases: ["salário mínimo", "mínimo", "piso nacional"],
    unit: "R$",
    periodicity: "monthly",
    aggregation: "last",
    source_name: "Governo Federal (decretos/leis do salário mínimo)",
    source_url: "https://www.gov.br/",
    tier: 1,
    notes: null,
    fetch: { kind: "none" },
    verified_by: "—",
    pending: "sem série oficial confirmada (código SGS ou Ipeadata não conferidos). Alternativa: tabela manual com links dos decretos.",
  },
  {
    code: "homicidios_taxa",
    name: "Taxa de homicídios por 100 mil habitantes",
    aliases: ["homicídios", "assassinatos", "mortes violentas", "violência"],
    unit: "por 100 mil hab.",
    periodicity: "annual",
    aggregation: "none",
    source_name: "Atlas da Violência (Ipea/FBSP) / Anuário Brasileiro de Segurança Pública",
    source_url: "https://forumseguranca.org.br/",
    tier: 1,
    notes: "Atlas (SIM/DataSUS) e Anuário (registros policiais) usam bases diferentes — não misturar.",
    fetch: { kind: "none" },
    verified_by: "—",
    pending: "sem API pública confirmada; dados vêm de planilhas anuais (carregar manualmente com link da publicação).",
  },
  {
    code: "bolsa_familia_familias",
    name: "Bolsa Família — famílias beneficiárias",
    aliases: ["bolsa família", "beneficiários do bolsa família", "famílias atendidas"],
    unit: "famílias",
    periodicity: "monthly",
    aggregation: "mean_or_last",
    source_name: "MDS / Portal da Transparência",
    source_url: "https://portaldatransparencia.gov.br/",
    tier: 1,
    notes: null,
    fetch: { kind: "none" },
    verified_by: "—",
    pending: "API do Portal da Transparência exige chave e endpoint não foi conferido; VIS Data (MDS) não confirmado.",
  },
];

export function activeSeries(includePending = false): CatalogSeries[] {
  return CATALOG.filter((s) => includePending || !s.pending);
}

/**
 * Linha para indicator_series (sem os campos internos do catálogo). Inclui `aggregation`,
 * que o comparador L2 lê pelo find_indicator (migration 20261019000007_indicator_aggregation).
 */
export function toSeriesRow(s: CatalogSeries): IndicatorSeries & { aggregation: IndicatorAggregation } {
  const { fetch: _f, fallback: _fb, verified_by: _v, pending: _p, ...row } = s;
  return row;
}
