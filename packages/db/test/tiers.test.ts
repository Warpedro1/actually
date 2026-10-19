// Tiers de fontes (SOURCE_TIERS). Um dos candidatos é o governo federal: o que governos
// publicam sobre si (notícias, Secom, Planalto, estados, prefeituras) é parte interessada e
// nunca pode virar tier 1–2 — nem sustentar vermelho, nem entrar na busca web (L4).
// Dado primário federal continua tier 1, mas só por domínio/caminho específico.
import { describe, expect, it } from "vitest";
import { SOURCE_TIERS, lookupSource, tierForUrl, webSearchDomains } from "../src/tiers";

const UFS = [
  "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa",
  "pb", "pe", "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to",
];

/** Gerador determinístico (mulberry32): rótulos "quaisquer", mas reprodutíveis. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rótulo DNS válido: [a-z0-9-], 1–20 caracteres, sem hífen nas pontas. */
function randomLabel(rand: () => number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-";
  const len = 1 + Math.floor(rand() * 20);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
  return s.replace(/^-+|-+$/g, "") || "x";
}

/** Caminhos que tentam imitar dado primário ou comunicação. */
const PATHS = ["/", "/noticias/2026/10/governo-anuncia", "/ccivil_03/leis/l8069.htm", "/secom/pt-br/assuntos/noticias/x", "/dados/serie.csv"];

/** Hosts de dado primário federal listados explicitamente em SOURCE_TIERS (tier ≤ 2, sob gov.br). */
const listedFederalHosts = new Set(
  SOURCE_TIERS.filter((t) => t.tier <= 2).map((t) => t.domain.split("/")[0]!).filter((h) => h.endsWith(".gov.br")),
);
const coveredByListed = (host: string) => [...listedFederalHosts].some((h) => host === h || host.endsWith("." + h));

const ufHost = new RegExp(`(^|\\.)(${UFS.join("|")})\\.gov\\.br$`);

describe("[RNF04] tiers: comunicação de governo é parte interessada, nunca tier 1–2", () => {
  it("gov.br genérico, Secom, Planalto, ministérios e agências de notícias de governo ficam fora do tier 1–2", () => {
    const urls = [
      "https://gov.br/",
      "https://www.gov.br/",
      "https://www.gov.br/secom/pt-br/assuntos/noticias/2026/10/inflacao-de-alimentos-cai",
      "https://www.gov.br/planalto/pt-br/acompanhe-o-planalto/noticias/2026/10/presidente-anuncia",
      "https://www.gov.br/saude/pt-br/assuntos/noticias/2026/outubro/x",
      "https://www.gov.br/fazenda/pt-br/assuntos/noticias/2026/outubro/x",
      "https://www2.planalto.gov.br/acompanhe-o-planalto/noticias/2022/x",
      "https://www.planalto.gov.br/",
      "https://agenciagov.ebc.com.br/noticias/202610/x",
    ];
    for (const url of urls) expect(tierForUrl(url), url).toBeGreaterThan(2);
  });

  it("qualquer subdomínio estadual ou municipal de gov.br (*.uf.gov.br) fica fora do tier 1–2", () => {
    const rand = prng(20261023);
    const known = [
      "saopaulo.sp.gov.br", "agenciasp.sp.gov.br", "capital.sp.gov.br", "prefeitura.sp.gov.br", "campinas.sp.gov.br",
      "al.sp.gov.br", "rj.gov.br", "rio.rj.gov.br", "agenciaminas.mg.gov.br", "agenciabrasilia.df.gov.br",
    ];
    const hosts = [...known];
    for (const uf of UFS) {
      hosts.push(`${uf}.gov.br`, `www.${uf}.gov.br`);
      for (let i = 0; i < 20; i++) {
        hosts.push(`${randomLabel(rand)}.${uf}.gov.br`, `www.${randomLabel(rand)}.${uf}.gov.br`, `${randomLabel(rand)}.${randomLabel(rand)}.${uf}.gov.br`);
      }
      // nomes de órgãos federais como subdomínio estadual continuam estaduais
      hosts.push(`ibge.${uf}.gov.br`, `planalto.${uf}.gov.br`, `tesouro.${uf}.gov.br`);
      // legislativos estaduais e municipais (*.uf.leg.br) não herdam o tier de camara.leg.br/senado.leg.br
      hosts.push(`${uf}.leg.br`, `camara.${randomLabel(rand)}.${uf}.leg.br`);
    }
    for (const host of hosts) {
      for (const path of PATHS) {
        const url = `https://${host}${path}`;
        expect(tierForUrl(url), url).toBeGreaterThan(2);
        expect(lookupSource(url)?.name ?? "", url).not.toMatch(/federal/i);
      }
    }
    // credencial na URL não engana o host
    expect(tierForUrl("https://ibge.gov.br@prefeitura.sp.gov.br/x")).toBeGreaterThan(2);
  });

  it("qualquer subdomínio federal de gov.br sem entrada específica fica fora do tier 1–2", () => {
    const rand = prng(1988);
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const host = `${randomLabel(rand)}.gov.br`;
      if (coveredByListed(host)) continue;
      for (const path of PATHS) expect(tierForUrl(`https://${host}${path}`), host + path).toBeGreaterThan(2);
      checked++;
    }
    expect(checked).toBeGreaterThan(450);
  });

  it("nenhuma entrada tier 1–2 é gov.br genérico, estadual/municipal ou caminho de comunicação", () => {
    for (const t of SOURCE_TIERS.filter((r) => r.tier <= 2)) {
      const [host, ...rest] = t.domain.split("/");
      expect(host, t.domain).not.toBe("gov.br");
      expect(host, t.domain).not.toMatch(ufHost);
      expect(rest.join("/"), t.domain).not.toMatch(/noticia|imprensa|secom|acompanhe/i);
    }
  });
});

describe("[RF07] tiers: dado primário federal continua tier 1 por domínio/caminho específico", () => {
  it("IBGE, BCB, Ipea, Tesouro, Transparência, legislação do Planalto, INPE, DataSUS e ANP", () => {
    const urls = [
      "https://sidra.ibge.gov.br/tabela/4099",
      "https://www.bcb.gov.br/estatisticas",
      "https://www.ipea.gov.br/atlasviolencia/",
      "https://www.ipeadata.gov.br/Default.aspx",
      "https://www.tesourotransparente.gov.br/temas/x",
      "https://siconfi.tesouro.gov.br/x",
      "https://portaldatransparencia.gov.br/beneficios/bolsa-familia",
      "https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/lei/l12871.htm",
      "http://www.planalto.gov.br/CCIVIL_03/Leis/L8069.htm",
      "https://terrabrasilis.dpi.inpe.br/app/dashboard/deforestation",
      "https://datasus.saude.gov.br/informacoes-de-saude-tabnet/",
      "http://tabnet.datasus.gov.br/cgi/tabcgi.exe?sim/cnv/obt10uf.def",
      "https://www.anp.gov.br/precos",
    ];
    for (const url of urls) expect(tierForUrl(url), url).toBe(1);
    expect(lookupSource("https://www.planalto.gov.br/ccivil_03/leis/l8069.htm")?.name).toBe("Planalto (legislação)");
  });
});

describe("[RF03] tiers: busca web (L4) só com domínios tier 1–2", () => {
  it("webSearchDomains não inclui gov.br genérico nem domínios estaduais/municipais", () => {
    const domains = webSearchDomains();
    expect(domains).not.toContain("gov.br");
    expect(domains).not.toContain("www.gov.br");
    for (const d of domains) expect(d, d).not.toMatch(ufHost);
  });

  it("todo domínio da busca web vem de uma entrada tier 1–2", () => {
    for (const d of webSearchDomains()) {
      expect(SOURCE_TIERS.some((t) => t.tier <= 2 && t.domain.split("/")[0] === d), d).toBe(true);
    }
  });
});
