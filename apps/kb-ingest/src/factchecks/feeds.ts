// Feeds RSS/Atom das agências de checagem.
//
// NENHUMA URL de feed foi fixada: deste ambiente os sites das agências estão
// bloqueados e não foi possível confirmar nenhum feed. Em vez de chutar caminhos
// (/feed, /rss...), o coletor DESCOBRE o feed em tempo de execução pela tag
// <link rel="alternate" type="application/rss+xml|atom+xml"> da página inicial
// de cada agência (domínios de SOURCE_TIERS, kind "checagem"). Feeds conferidos
// à mão podem ser fixados em sources/feeds.yaml (ver o arquivo) e têm prioridade.
import { readFileSync, existsSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { parse as parseYaml } from "yaml";
import { SOURCE_TIERS } from "@actually/db";
import { fetchText } from "../lib/http";
import type { FactcheckCandidate } from "./normalize";

export interface Agency {
  name: string;
  /** Página inicial (domínio de SOURCE_TIERS, com o caminho quando houver). */
  home: string;
}

export function agencies(): Agency[] {
  return SOURCE_TIERS.filter((t) => t.kind === "checagem").map((t) => ({ name: t.name, home: `https://${t.domain}/` }));
}

/** Feeds fixados à mão (sources/feeds.yaml): { feeds: [{ name, url }] }. */
export function loadPinnedFeeds(path: string): { name: string; url: string }[] {
  if (!existsSync(path)) return [];
  const doc = parseYaml(readFileSync(path, "utf8")) as { feeds?: { name: string; url: string }[] | null } | null;
  return (doc?.feeds ?? []).filter((f) => f && /^https?:\/\//.test(f.url));
}

/** Links de feed anunciados no <head> (auto-descoberta). Pura. */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const { document } = parseHTML(html);
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll('link[rel~="alternate"]')) as any[]) {
    const type = String(el.getAttribute("type") ?? "").toLowerCase();
    const href = el.getAttribute("href");
    if (!href || !/(rss|atom)\+xml/.test(type)) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      // feeds de comentários não interessam
      if (!/comments?/i.test(abs) && !out.includes(abs)) out.push(abs);
    } catch {
      /* href inválido */
    }
  }
  return out;
}

export interface FeedItem {
  title: string | null;
  url: string;
  publishedAt: string | null;
  categories: string[];
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as object)) return text((v as { "#text": unknown })["#text"]);
  return null;
}
const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** RSS 2.0 ou Atom → itens. Pura. */
export function parseFeed(xmlText: string): FeedItem[] {
  const doc = xml.parse(xmlText) as Record<string, any>;
  const items: FeedItem[] = [];
  for (const it of arr(doc?.rss?.channel?.item)) {
    const url = text(it.link) ?? text(it.guid);
    if (!url || !/^https?:\/\//.test(url)) continue;
    items.push({
      title: text(it.title),
      url,
      publishedAt: text(it.pubDate) ?? text(it["dc:date"]),
      categories: arr(it.category).map(text).filter((c): c is string => Boolean(c)),
    });
  }
  for (const e of arr(doc?.feed?.entry)) {
    const links = arr(e.link) as Record<string, string>[];
    const href = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate")?.["@_href"];
    if (!href) continue;
    items.push({
      title: text(e.title),
      url: href,
      publishedAt: text(e.published) ?? text(e.updated),
      categories: arr(e.category).map((c: any) => c?.["@_term"]).filter(Boolean),
    });
  }
  return items;
}

export async function collectFeeds(opts: {
  /** sources/feeds.yaml (CLI) ou a lista já lida (painel do /admin, sem disco). */
  pinnedPath?: string;
  pinned?: { name: string; url: string }[];
  since?: string;
  log: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
}): Promise<{ candidates: FactcheckCandidate[]; feedsUsed: { agency: string; url: string }[] }> {
  const pinned = opts.pinned ?? (opts.pinnedPath ? loadPinnedFeeds(opts.pinnedPath) : []);
  const feedsUsed: { agency: string; url: string }[] = pinned.map((p) => ({ agency: p.name, url: p.url }));
  for (const a of agencies()) {
    if (pinned.some((p) => p.name === a.name)) continue;
    try {
      const links = discoverFeedLinks(await fetchText(a.home, { respectRobots: true }), a.home);
      if (links[0]) feedsUsed.push({ agency: a.name, url: links[0] });
      else opts.warn(`${a.name}: nenhum feed anunciado em ${a.home}`);
    } catch (e) {
      opts.warn(`${a.name}: não consegui abrir ${a.home} — ${(e as Error).message}`);
    }
  }
  const sinceTs = opts.since ? Date.parse(opts.since) : -Infinity;
  const candidates: FactcheckCandidate[] = [];
  for (const f of feedsUsed) {
    try {
      const items = parseFeed(await fetchText(f.url, { respectRobots: true }));
      const recent = items.filter((i) => !i.publishedAt || Date.parse(i.publishedAt) >= sinceTs);
      opts.log(`  feed ${f.agency} (${f.url}): ${items.length} itens, ${recent.length} no período`);
      for (const i of recent) {
        candidates.push({ url: i.url, sourceName: f.agency, title: i.title, publishedAt: i.publishedAt });
      }
    } catch (e) {
      opts.warn(`feed ${f.agency} (${f.url}) falhou — ${(e as Error).message}`);
    }
  }
  return { candidates, feedsUsed };
}
