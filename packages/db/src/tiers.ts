import type { SourceTier, SourceTierRow } from "./types";

// Lista canônica de fontes por confiabilidade. É a fonte da verdade:
// o pipeline consulta direto daqui e `kb-ingest tiers` sincroniza com a tabela source_tiers.
//   1 = dado oficial primário / checagem profissional
//   2 = imprensa de referência / academia
//   3 = imprensa geral / material de campanha (fato sobre o que foi dito/proposto)
//   4 = qualquer outra coisa (nunca sustenta alerta sozinho)
//
// Governo: só é tier 1 por domínio ou caminho específico de órgão que publica dado primário
// (estatística, contas públicas, legislação). Nunca "gov.br" inteiro: comunicação de governo
// (notícias, Secom, Planalto, ministérios em www.gov.br, governos estaduais e prefeituras em
// *.uf.gov.br) é parte interessada no debate — um dos candidatos é o governo federal.
export const SOURCE_TIERS: SourceTierRow[] = [
  // Oficiais (dado primário)
  { domain: "ibge.gov.br", name: "IBGE", tier: 1, kind: "oficial" },
  { domain: "bcb.gov.br", name: "Banco Central", tier: 1, kind: "oficial" },
  { domain: "ipea.gov.br", name: "Ipea", tier: 1, kind: "oficial" },
  { domain: "ipeadata.gov.br", name: "Ipeadata", tier: 1, kind: "oficial" },
  { domain: "inpe.br", name: "INPE", tier: 1, kind: "oficial" },
  { domain: "tse.jus.br", name: "TSE", tier: 1, kind: "oficial" },
  // acervo histórico (datas dos mandatos), não comunicação de governo
  { domain: "biblioteca.presidencia.gov.br", name: "Biblioteca da Presidência da República", tier: 1, kind: "oficial" },
  { domain: "stf.jus.br", name: "STF", tier: 1, kind: "oficial" },
  { domain: "stj.jus.br", name: "STJ", tier: 1, kind: "oficial" },
  // demais tribunais (TRFs, TJs, CNJ): decisão judicial é o registro primário de processo
  { domain: "jus.br", name: "Poder Judiciário", tier: 1, kind: "oficial" },
  // Ministério Público: é a parte que acusa. Registra que houve denúncia ou pedido de
  // arquivamento, mas é a versão de um lado: nível 2 (não sustenta vermelho de acusação)
  { domain: "mpf.mp.br", name: "Ministério Público Federal", tier: 2, kind: "oficial" },
  { domain: "mp.br", name: "Ministério Público", tier: 2, kind: "oficial" },
  { domain: "senado.leg.br", name: "Senado Federal", tier: 1, kind: "oficial" },
  { domain: "camara.leg.br", name: "Câmara dos Deputados", tier: 1, kind: "oficial" },
  // só a legislação compilada; o resto do Planalto é comunicação do governo (cai em "gov.br")
  { domain: "planalto.gov.br/ccivil_03", name: "Planalto (legislação)", tier: 1, kind: "oficial" },
  { domain: "portaldatransparencia.gov.br", name: "Portal da Transparência", tier: 1, kind: "oficial" },
  { domain: "tesourotransparente.gov.br", name: "Tesouro Nacional", tier: 1, kind: "oficial" },
  { domain: "tesouro.gov.br", name: "Tesouro Nacional", tier: 1, kind: "oficial" },
  { domain: "anp.gov.br", name: "ANP", tier: 1, kind: "oficial" },
  { domain: "datasus.saude.gov.br", name: "DataSUS", tier: 1, kind: "oficial" },
  { domain: "datasus.gov.br", name: "DataSUS", tier: 1, kind: "oficial" },
  { domain: "forumseguranca.org.br", name: "Fórum Brasileiro de Segurança Pública", tier: 1, kind: "academico" },
  // Checagem profissional
  { domain: "lupa.uol.com.br", name: "Agência Lupa", tier: 1, kind: "checagem" },
  { domain: "aosfatos.org", name: "Aos Fatos", tier: 1, kind: "checagem" },
  { domain: "estadao.com.br/estadao-verifica", name: "Estadão Verifica", tier: 1, kind: "checagem" },
  { domain: "g1.globo.com/fato-ou-fake", name: "Fato ou Fake (g1)", tier: 1, kind: "checagem" },
  { domain: "projetocomprova.com.br", name: "Projeto Comprova", tier: 1, kind: "checagem" },
  { domain: "noticias.uol.com.br/confere", name: "UOL Confere", tier: 1, kind: "checagem" },
  { domain: "checamos.afp.com", name: "AFP Checamos", tier: 1, kind: "checagem" },
  // Imprensa de referência / academia
  { domain: "folha.uol.com.br", name: "Folha de S.Paulo", tier: 2, kind: "imprensa" },
  { domain: "estadao.com.br", name: "Estadão", tier: 2, kind: "imprensa" },
  { domain: "oglobo.globo.com", name: "O Globo", tier: 2, kind: "imprensa" },
  { domain: "g1.globo.com", name: "g1", tier: 2, kind: "imprensa" },
  { domain: "valor.globo.com", name: "Valor Econômico", tier: 2, kind: "imprensa" },
  { domain: "bbc.com", name: "BBC", tier: 2, kind: "imprensa" },
  { domain: "reuters.com", name: "Reuters", tier: 2, kind: "imprensa" },
  { domain: "agenciabrasil.ebc.com.br", name: "Agência Brasil", tier: 2, kind: "imprensa" },
  { domain: "poder360.com.br", name: "Poder360", tier: 2, kind: "imprensa" },
  { domain: "piaui.folha.uol.com.br", name: "piauí", tier: 2, kind: "imprensa" },
  { domain: "fgv.br", name: "FGV", tier: 2, kind: "academico" },
  { domain: "scielo.br", name: "SciELO", tier: 2, kind: "academico" },
  // Imprensa geral
  { domain: "uol.com.br", name: "UOL", tier: 3, kind: "imprensa" },
  { domain: "cnnbrasil.com.br", name: "CNN Brasil", tier: 3, kind: "imprensa" },
  { domain: "metropoles.com", name: "Metrópoles", tier: 3, kind: "imprensa" },
  { domain: "exame.com", name: "Exame", tier: 3, kind: "imprensa" },
  { domain: "infomoney.com.br", name: "InfoMoney", tier: 3, kind: "imprensa" },
  // Parte interessada: qualquer *.gov.br sem entrada específica acima (www.gov.br/secom,
  // gov.br/planalto/.../noticias, sp.gov.br, prefeituras...) cai aqui — tier 4: nunca sustenta
  // alerta e fica fora da busca web. Explícita (em vez de omitida) para `kb-ingest tiers`
  // sobrescrever em source_tiers a antiga linha "gov.br" tier 1.
  { domain: "gov.br", name: "Governo (gov.br)", tier: 4, kind: "oficial" },
];

function hostAndPath(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, "").toLowerCase(), path: u.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

/** Entrada mais específica que casa com a URL (domínio com caminho > domínio > domínio pai). */
export function lookupSource(url: string, tiers: SourceTierRow[] = SOURCE_TIERS): SourceTierRow | null {
  const hp = hostAndPath(url);
  if (!hp) return null;
  let best: SourceTierRow | null = null;
  let bestLen = -1;
  for (const t of tiers) {
    const [domain, ...rest] = t.domain.split("/");
    const prefix = rest.length ? "/" + rest.join("/") : "";
    const hostOk = hp.host === domain || hp.host.endsWith("." + domain);
    const pathOk = !prefix || hp.path.startsWith(prefix);
    if (hostOk && pathOk && t.domain.length > bestLen) {
      best = t;
      bestLen = t.domain.length;
    }
  }
  return best;
}

export function tierForUrl(url: string): SourceTier {
  return lookupSource(url)?.tier ?? 4;
}

/** Domínios aceitos na busca web (L4) — tiers 1 e 2. */
export function webSearchDomains(maxTier: SourceTier = 2): string[] {
  return [...new Set(SOURCE_TIERS.filter((t) => t.tier <= maxTier).map((t) => t.domain.split("/")[0]!))];
}
