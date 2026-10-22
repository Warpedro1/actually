// "A base aprende com a web": páginas que a busca web (L4, só nível 1–2) trouxe durante
// a checagem ao vivo ficam na fila kb_web_finds (o pipeline só grava a fila). Aqui cada
// página vira checagem L1 (página de agência com selo e data, no tema) ou documento L3,
// sempre com origin 'web'. O texto veio da Tavily, sem passar pelo robots.txt: a página só
// é usada se o robots.txt da URL permitir. Página de lista (home, seção, tag) não vira
// documento. Uma página com problema é marcada e a fila segue.
import { lookupSource, tierForUrl, type DocType, type KbWebFind, type SourceTier } from "@actually/db";
import { ingestDocument, type DocumentInput } from "../documents/ingest";
import {
  buildFactcheckRow,
  canonicalUrl,
  cleanPageTitle,
  dateFromText,
  dateFromUrl,
  isListingPage,
  isRelevant,
  pageFromText,
} from "../factchecks/normalize";
import { detectPerson, detectTopics } from "../lib/classify";
import { requireDb, type Ctx, type Db } from "../lib/ctx";
import { robotsPermits } from "../lib/robots";
import { cleanText, stripRelatedLinks } from "../lib/text";
import { urlsInBase, writeFactchecks } from "./factchecks";

export const WEB_ORIGIN = "web";
/** Texto limpo mais curto que isto não é página de conteúdo (menu, paywall, erro). */
export const WEB_FIND_MIN_TEXT = 500;
const NOTE_MAX = 200;

type Outcome = { status: "done" | "skipped" | "failed"; note: string };

/** Texto em português sem nenhum acento: codificação perdida na leitura (ex.: windows-1252 lido como UTF-8). */
export function accentsLost(text: string): boolean {
  return !/[áàâãéêíóôõúüç]/i.test(text);
}

/** Tipo do documento pelo tipo da fonte (o pipeline não decide nada com isto). */
export function webDocType(url: string): DocType {
  const src = lookupSource(url);
  if (src?.domain.startsWith("planalto.gov.br/ccivil_03")) return "lei";
  if (src?.kind === "imprensa" || src?.kind === "checagem") return "noticia";
  return "outro";
}

/** Página da fila → documento L3 (origin 'web'). Pura. */
export function webFindDocument(f: KbWebFind, url: string, text: string): DocumentInput {
  const title = cleanPageTitle(f.title, url) || f.source_name;
  const head = text.slice(0, 5000);
  return {
    url,
    title,
    doc_type: webDocType(url),
    person: detectPerson(title, head),
    source_name: f.source_name || lookupSource(url)?.name || new URL(url).hostname,
    tier: tierForUrl(url) as SourceTier,
    published_at: f.published_at ?? dateFromUrl(url) ?? dateFromText(text),
    topics: detectTopics(title, head).slice(0, 3),
    body: text,
    origin: WEB_ORIGIN,
  };
}

async function processOne(ctx: Ctx, f: KbWebFind, inBase: Set<string>): Promise<Outcome> {
  const url = canonicalUrl(f.url);
  if (inBase.has(f.url) || inBase.has(url)) return { status: "skipped", note: "ja_na_base" };
  const text = stripRelatedLinks(cleanText(f.text));
  if (text.length < WEB_FIND_MIN_TEXT) return { status: "skipped", note: "texto_curto" };
  if (accentsLost(text)) return { status: "skipped", note: "sem_acento" };
  // erro ao ler o robots.txt também é "não" (na dúvida, não usa)
  if (!(await robotsPermits(url))) return { status: "skipped", note: "robots_txt" };

  let note = "documento";
  const publishedAt = f.published_at ?? dateFromUrl(url);
  const page = lookupSource(url)?.kind === "checagem" ? pageFromText({ url, title: f.title, text, publishedAt }) : null;
  const r = page ? buildFactcheckRow({ url, publishedAt }, page) : null;
  if (r?.ok && isRelevant(r.row)) {
    await writeFactchecks(ctx, [{ ...r.row, origin: WEB_ORIGIN }]);
    note = "checagem";
  } else if (isListingPage(url, text)) {
    return { status: "skipped", note: "lista" };
  } else {
    await ingestDocument(ctx, webFindDocument(f, url, text));
  }
  // a mesma página repetida no lote (URL com e sem utm) não entra de novo
  inBase.add(url);
  return { status: "done", note };
}

async function mark(db: Db, ids: string[], patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("kb_web_finds").update(patch).in("id", ids);
  if (error) throw new Error(`kb_web_finds: ${error.message}`);
}

/**
 * Processa as páginas já pegas da fila (kb_web_finds_claim), em ordem, enquanto houver
 * tempo; as que não começaram voltam para "pending" na hora (sem esperar o claim vencer).
 * Devolve a contagem por resultado ("done:documento", "skipped:ja_na_base"...).
 */
export async function processWebFinds(ctx: Ctx, finds: KbWebFind[], timeLeft: () => number = () => 1): Promise<Record<string, number>> {
  const db = requireDb(ctx);
  const tally: Record<string, number> = {};
  if (!finds.length) return tally;
  const inBase = await urlsInBase(db, finds.flatMap((f) => [f.url, canonicalUrl(f.url)]));
  let i = 0;
  for (; i < finds.length && timeLeft() > 0; i++) {
    const f = finds[i]!;
    let out: Outcome;
    try {
      out = await processOne(ctx, f, inBase);
    } catch (e) {
      const msg = (e as Error).message;
      out = { status: "failed", note: msg.length > NOTE_MAX ? `${msg.slice(0, NOTE_MAX)}…` : msg };
      ctx.warn(`captura ${f.url}: ${msg}`);
    }
    await mark(db, [f.id], { status: out.status, note: out.note, processed_at: new Date().toISOString() });
    const key = out.status === "failed" ? "failed" : `${out.status}:${out.note}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  const left = finds.slice(i);
  if (left.length) {
    await mark(db, left.map((f) => f.id), { status: "pending", claimed_at: null });
    tally.devolvidas = left.length;
  }
  ctx.log(`capturas da web: ${finds.length} pegas da fila; ${JSON.stringify(tally)}`);
  return tally;
}
