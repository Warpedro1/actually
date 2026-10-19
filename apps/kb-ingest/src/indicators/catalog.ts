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
// Antes do debate: rode `indicators --check` numa máquina com acesso e confira os
// últimos valores contra a página pública de cada série.
//
// Séries com `pending` NÃO são carregadas (só com --include-pending): código ou
// fonte não confirmados. O motivo fica registrado aqui e no relatório.
import type { IndicatorSeries } from "@actually/db";
import { sgsPublicUrl } from "./sgs";
import { sidraPublicUrl } from "./sidra";

export type SeriesFetch =
  | { kind: "sgs"; code: number; daily?: { aggregate: "last" | "mean" } }
  | { kind: "sidra"; table: string; variable: string; classification?: string }
  | { kind: "none" };

export interface CatalogSeries extends IndicatorSeries {
  fetch: SeriesFetch;
  /** Como o código foi conferido (ver cabeçalho). */
  verified_by: string;
  /** Preenchido quando a série NÃO pode ser carregada ainda. */
  pending?: string;
}

const BCB = "Banco Central do Brasil (SGS)";
const IBGE = "IBGE (SIDRA)";

export const CATALOG: CatalogSeries[] = [
  // ------------------------------------------------------------------ preços
  {
    code: "ipca_mensal",
    name: "IPCA — variação mensal",
    aliases: ["ipca", "inflação", "inflação mensal", "inflação do mês", "índice de preços ao consumidor amplo", "custo de vida"],
    unit: "%",
    periodicity: "monthly",
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
    aliases: ["inflação em 12 meses", "inflação acumulada", "inflação anual", "inflação no ano", "ipca acumulado", "ipca 12 meses"],
    unit: "%",
    periodicity: "monthly",
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
    aliases: ["desemprego", "taxa de desemprego", "desocupação", "taxa de desocupação", "desempregados"],
    unit: "%",
    periodicity: "quarterly",
    source_name: "IBGE — PNAD Contínua, tabela 4099",
    source_url: sidraPublicUrl("4099"),
    tier: 1,
    notes: "Pessoas de 14 anos ou mais. Trimestres civis (jan-mar, abr-jun, jul-set, out-dez).",
    fetch: { kind: "sidra", table: "4099", variable: "4099" },
    verified_by: "ibge-v3",
  },
  {
    code: "desocupacao_pnadc_movel",
    name: "Taxa de desocupação — PNAD Contínua (trimestre móvel)",
    aliases: ["desemprego", "taxa de desemprego", "desocupação", "desemprego atual", "menor desemprego", "desemprego mensal"],
    unit: "%",
    periodicity: "moving_quarter",
    source_name: "IBGE — PNAD Contínua (série 24369 do SGS/BCB)",
    source_url: sgsPublicUrl(24369),
    tier: 1,
    notes:
      "Divulgação mensal do IBGE, cada ponto é um trimestre móvel rotulado pelo último mês. " +
      "`indicators --check` compara os pontos de mar/jun/set/dez com a série trimestral (4099).",
    fetch: { kind: "sgs", code: 24369 },
    verified_by: "bcb-medido",
  },
  {
    code: "pib_variacao_trimestral",
    name: "PIB — variação em volume no trimestre contra o mesmo trimestre do ano anterior",
    aliases: ["pib", "crescimento do pib", "crescimento da economia", "variação do pib", "pib trimestral"],
    unit: "%",
    periodicity: "quarterly",
    source_name: "IBGE — Contas Nacionais Trimestrais, tabela 5932",
    source_url: sidraPublicUrl("5932"),
    tier: 1,
    notes: "PIB a preços de mercado (c11255/90707). Não é o crescimento do ano; ver pib_variacao_anual (pendente).",
    fetch: { kind: "sidra", table: "5932", variable: "6561", classification: "c11255/90707" },
    verified_by: "ibge-v3",
  },
  {
    code: "pib_corrente_trimestral",
    name: "PIB a preços correntes (trimestral)",
    aliases: ["tamanho do pib", "pib em reais", "valor do pib"],
    unit: "R$ milhões",
    periodicity: "quarterly",
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
    source_name: "IBGE — Contas Nacionais Anuais, tabela 6784",
    source_url: sidraPublicUrl("6784"),
    tier: 1,
    notes: null,
    fetch: { kind: "sidra", table: "6784", variable: "9812" },
    verified_by: "ibge-v3",
  },
  {
    code: "pib_variacao_anual",
    name: "PIB — variação real anual",
    aliases: ["crescimento do pib no ano", "pib cresceu", "crescimento anual", "pib anual"],
    unit: "%",
    periodicity: "annual",
    source_name: IBGE,
    source_url: sidraPublicUrl("6784"),
    tier: 1,
    notes: null,
    fetch: { kind: "none" },
    verified_by: "—",
    pending:
      "variável da taxa de variação real anual não confirmada (tabela 6784 ou 5932 'acumulado em 4 trimestres'). " +
      "Confirme em servicodados.ibge.gov.br/api/v3/agregados/6784/metadados.",
  },
  {
    code: "rendimento_medio_real",
    name: "Rendimento médio real efetivo de todos os trabalhos — PNAD Contínua (trimestre móvel)",
    aliases: ["renda", "renda do trabalhador", "salário médio", "rendimento médio", "renda média"],
    unit: "R$",
    periodicity: "moving_quarter",
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
    source_name: "Ministério do Trabalho — Caged (série 28561 do SGS/BCB)",
    source_url: sgsPublicUrl(28561),
    tier: 1,
    notes: "Nome herdado no catálogo de referência (série sem dataset no portal do BCB): confira o último valor com o MTE antes de usar.",
    fetch: { kind: "sgs", code: 28561 },
    verified_by: "bcb-medido",
  },
  // ------------------------------------------------------------------ pendentes (outros tópicos)
  {
    code: "desmatamento_prodes_amazonia",
    name: "Desmatamento na Amazônia Legal — PRODES (taxa anual)",
    aliases: ["desmatamento", "desmatamento na amazônia", "prodes", "área desmatada"],
    unit: "km²",
    periodicity: "annual",
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

/** Linha para indicator_series (sem os campos internos do catálogo). */
export function toSeriesRow(s: CatalogSeries): IndicatorSeries {
  const { fetch: _f, verified_by: _v, pending: _p, ...row } = s;
  return row;
}
