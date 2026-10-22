// robots.txt mínimo: grupos por User-agent, Allow/Disallow por prefixo (com * e $),
// regra mais específica vence, e Crawl-delay. Segue a convenção do RFC 9309:
// 4xx no robots.txt ⇒ tudo permitido; 5xx/rede ⇒ nada permitido (na dúvida, não raspa).
import { ROBOTS_TOKEN, USER_AGENT } from "./http";

export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[];
  crawlDelayMs: number | null;
}

/** Interpreta o robots.txt e devolve as regras do grupo que vale para `token`. */
export function parseRobots(txt: string, token: string): RobotsRules {
  type Group = { agents: string[]; rules: RobotsRules["rules"]; delay: number | null };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (val) cur.rules.push({ allow: key === "allow", pattern: val });
    } else if (key === "crawl-delay") {
      const n = Number(val);
      if (Number.isFinite(n)) cur.delay = n * 1000;
    }
  }
  const t = token.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelayMs: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
  };
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** Regra mais longa que casa decide; empate favorece Allow. Sem regra ⇒ permitido. */
export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules.rules) {
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

const cache = new Map<string, Promise<RobotsRules | "deny-all">>();

async function load(origin: string): Promise<RobotsRules | "deny-all"> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 400 && res.status < 500) return { rules: [], crawlDelayMs: null };
    if (!res.ok) return "deny-all";
    return parseRobots(await res.text(), ROBOTS_TOKEN);
  } catch {
    return "deny-all";
  }
}

function rulesFor(url: string) {
  const origin = new URL(url).origin;
  let p = cache.get(origin);
  if (!p) {
    p = load(origin);
    cache.set(origin, p);
  }
  return p;
}

export async function robotsAllows(url: string): Promise<boolean> {
  const r = await rulesFor(url);
  if (r === "deny-all") return false;
  const u = new URL(url);
  return isAllowed(r, u.pathname + u.search);
}

/**
 * Como robotsAllows, mas nunca lança: URL inválida ou erro ⇒ proibido (na dúvida, não usa).
 * Para página que chegou pronta por outro caminho (texto da Tavily), que não passou pelo
 * fetchWithRetry com respectRobots.
 */
export async function robotsPermits(url: string): Promise<boolean> {
  try {
    return await robotsAllows(url);
  } catch {
    return false;
  }
}

/** Esquece os robots.txt já lidos (testes: cada um define o seu). */
export function clearRobotsCache(): void {
  cache.clear();
}

export async function robotsCrawlDelayMs(url: string): Promise<number | null> {
  const r = await rulesFor(url);
  return r === "deny-all" ? null : r.crawlDelayMs;
}
