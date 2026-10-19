import type { SourceTier, SourceTierRow } from "./types";

// Lista canônica de fontes por confiabilidade. É a fonte da verdade:
// o pipeline consulta direto daqui e `kb-ingest tiers` sincroniza com a tabela source_tiers.
//   1 = dado oficial primário / checagem profissional
//   2 = imprensa de referência / academia
//   3 = imprensa geral / material de campanha (fato sobre o que foi dito/proposto)
//   4 = qualquer outra coisa (nunca sustenta alerta sozinho)
export const SOURCE_TIERS: SourceTierRow[] = [
  // Oficiais
  { domain: "ibge.gov.br", name: "IBGE", tier: 1, kind: "oficial" },
  { domain: "bcb.gov.br", name: "Banco Central", tier: 1, kind: "oficial" },
  { domain: "ipea.gov.br", name: "Ipea", tier: 1, kind: "oficial" },
  { domain: "inpe.br", name: "INPE", tier: 1, kind: "oficial" },
  { domain: "tse.jus.br", name: "TSE", tier: 1, kind: "oficial" },
  { domain: "stf.jus.br", name: "STF", tier: 1, kind: "oficial" },
  { domain: "senado.leg.br", name: "Senado Federal", tier: 1, kind: "oficial" },
  { domain: "camara.leg.br", name: "Câmara dos Deputados", tier: 1, kind: "oficial" },
  { domain: "planalto.gov.br", name: "Planalto (legislação)", tier: 1, kind: "oficial" },
  { domain: "portaldatransparencia.gov.br", name: "Portal da Transparência", tier: 1, kind: "oficial" },
  { domain: "tesourotransparente.gov.br", name: "Tesouro Nacional", tier: 1, kind: "oficial" },
  { domain: "tesouro.gov.br", name: "Tesouro Nacional", tier: 1, kind: "oficial" },
  { domain: "gov.br", name: "Governo Federal", tier: 1, kind: "oficial" },
  { domain: "anp.gov.br", name: "ANP", tier: 1, kind: "oficial" },
  { domain: "datasus.saude.gov.br", name: "DataSUS", tier: 1, kind: "oficial" },
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
