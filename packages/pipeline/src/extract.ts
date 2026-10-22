// Filtro + extração numa única chamada Haiku (latência): devolve as
// afirmações checáveis atômicas da fala atual, com contexto resolvido.
import type { IndicatorRef } from "@actually/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL_EXTRACT, TIMEOUTS_MS } from "./config";
import type { AnthropicLike } from "./deps";
import type { Logger } from "./log";
import { normalizeClaimNumbers } from "./normalize";
import { normalizeForQuote, quoteCheck } from "./quoteCheck";
import { CLAIM_KINDS, DROPPED_KINDS, TOPICS, type ClaimKind, type ExtractedClaim, type ReferenceRef, type Topic } from "./types";
import { anthropicUsageRow, type UsageMeter } from "./usage";

// Schema leniente de propósito: enums viram texto e são validados em código,
// para que um campo secundário fora do padrão não derrube a extração inteira.
export const ExtractionSchema = z.object({
  claims: z.array(
    z.object({
      text_original: z.string().describe("Trecho literal da fala atual que contém a afirmação."),
      text_normalized: z.string().describe("Afirmação autossuficiente em PT-BR, com sujeito e tempo resolvidos."),
      topic: z.string().describe(`Um de: ${TOPICS.join(", ")}`),
      // lista fechada (a saída estruturada garante o valor): um tipo livre como "acusação",
      // com acento, cairia em "fato" e escaparia das regras da acusação/opinião/previsão
      tipo: z.enum([...CLAIM_KINDS, ...DROPPED_KINDS]).describe("Tipo da fala."),
      measurable: z
        .string()
        .nullable()
        .describe("Só para opiniao_mensuravel e previsao: o dado ou a projeção pública que mede a fala. null nos outros tipos."),
      numbers: z.array(
        z.object({
          value: z.number().describe("Valor numérico absoluto (\"1,5 milhão\" → 1500000; \"6%\" → 6)."),
          unit: z.string().nullable().describe("\"%\", \"p.p.\", \"R$\", \"km2\" ou null."),
          raw: z.string().describe("Como foi dito, ex.: \"quase 10 milhões\"."),
        }),
      ),
      indicator: z
        .object({
          query: z.string().describe("Nome do indicador como dito (ex.: \"desemprego\", \"inflação\")."),
          period: z.string().nullable().describe("AAAA | AAAA-T1..T4 | AAAA-MM | intervalo INICIO..FIM; null se 'hoje/atual'."),
          claimed_value: z.number().nullable(),
          unit: z.string().nullable(),
          kind: z.string().describe("level | change_abs | change_pct | max | min"),
        })
        .nullable(),
      reference: z
        .object({
          type: z.string().describe("tempo_no_poder | eleicao"),
          subject: z.string().describe("Pessoa ou partido (tempo_no_poder) ou candidato (eleicao), como dito."),
          window_years: z.number().nullable().describe("tempo_no_poder: janela em anos (\"dos últimos 24 anos\" → 24); null = tempo total."),
          year: z.number().nullable().describe("eleicao: ano da eleição."),
          round: z.number().nullable().describe("eleicao: turno (1 ou 2)."),
          claimed_value: z.number().describe("Número afirmado (anos, votos ou %)."),
          unit: z.string().describe("anos | votos | %"),
          qualifier: z.string().describe("exato | cerca_de | mais_de | menos_de | quase"),
        })
        .nullable(),
      time_reference: z.string().nullable().describe("Referência temporal resolvida, ex.: \"2023\", \"2019 a 2022\"."),
    }),
  ),
});
export type ExtractionOutput = z.infer<typeof ExtractionSchema>;

const INDICATOR_KINDS: IndicatorRef["kind"][] = ["level", "change_abs", "change_pct", "max", "min"];

// Prompt de sistema estável (sem data nem nada variável) — bom para cache.
export const EXTRACT_SYSTEM = `Você é o extrator de afirmações checáveis de um sistema de checagem de fatos AO VIVO do debate presidencial brasileiro de 2026 (Lula x Flávio Bolsonaro). Precisão vale mais que cobertura: na dúvida, NÃO extraia.

Você recebe a transcrição automática dos últimos segundos (<contexto>) e a fala atual (<fala_atual>). Extraia da fala atual as afirmações que podem ser julgadas com dados ou fontes públicas, e classifique cada uma em "tipo":
- "fato": fato verificável — ato de governo, lei, votação, data, evento, declaração passada, resultado de política.
- "estatistica": número, percentual, valor ou indicador.
- "acusacao": situação judicial ou policial de uma pessoa ou partido (preso, condenado, réu, denunciado, investigado, indiciado, inelegível, absolvido, processo anulado ou arquivado) ou escândalo concreto. Só a parte factual: "ele foi condenado por corrupção" entra; "ele é ladrão" é opinião.
- "opiniao_mensuravel": juízo de valor ou exagero cuja essência um dado público mede. Ex.: "não tem mais carne na mesa do brasileiro" (consumo de carne por pessoa); "os estados fracassaram na segurança" (taxas de homicídio por estado). Preencha "measurable" com o dado que mede a fala.
- "previsao": previsão ou projeção sobre o futuro que dá para comparar com projeções publicadas (Banco Central/Focus, IFI, Tesouro, FMI, agências de rating). Ex.: "o Brasil vai crescer 3% no ano que vem". Preencha "measurable" com a projeção a consultar.
- "promessa": compromisso do próprio falante sobre o que vai fazer ("vou construir 500 mil vagas"). Não dá para medir; marque assim e o sistema descarta.
- "opiniao": juízo de valor sem base mensurável, ataque pessoal ou adjetivo ("ele é incompetente", "passa a mão na cabeça de bandido"). Marque assim e o sistema descarta.

NÃO extraia:
- cumprimentos, falas do mediador, regras do debate, fatos sobre o próprio debate, perguntas;
- hipóteses, condicionais e insinuações ("se eu tivesse...", "poderia ter...", "o dinheiro pode ser do aposentado", "talvez ele esteja...");
- promessas disfarçadas de fato ("com X presidente você vai ter...", "no meu governo vai ter...") — são "promessa";
- afirmações cujo sujeito, objeto ou período não dá para resolver com segurança pelo contexto.

Para cada afirmação:
- text_original: trecho LITERAL da fala atual (copie exatamente como transcrito).
- text_normalized: frase autossuficiente em português, com sujeito e tempo explícitos. Em opinião e previsão, mantenha o sentido literal da fala (a métrica vai em "measurable", não no texto). Resolva "isso", "ele", "lá", "no meu governo", "no governo dele", "ano passado" usando o contexto e a data do debate. Se o falante não puder ser identificado com segurança, NÃO atribua o governo a ninguém — descarte a afirmação se ela depender disso.
- FIDELIDADE: a afirmação normalizada diz exatamente o que a fala diz. Nunca acrescente período, ano, "e não X", escopo, causa, pessoa, nome ou situação jurídica que não estejam na fala atual ou no contexto. Se o mesmo falante deu o período no contexto (ex.: "em 2010" segundos antes), use-o; se não deu, não invente. Mantenha o verbo dito ("fugido" não vira "foragido"; "foi do seu governo" não vira "foi vinculado ao governo"). "Seu irmão", "seu filho", "seu pai" são parentes do interlocutor, nunca o próprio interlocutor. "Eles" só se resolve se o contexto disser quem são.
- Uma afirmação = um fato. Separe frases com dois fatos em duas afirmações.
- topic: economia, impostos, programas_sociais, seguranca, corrupcao_justica, saude, meio_ambiente, educacao, politica_externa ou outro.
- numbers: todos os números da afirmação, com valor absoluto ("1,5 milhão" → 1500000; "R$ 600" → 600 com unidade "R$"; "6%" → 6 com unidade "%").
- indicator: preencha só quando a afirmação é sobre o valor de um indicador oficial (desemprego/desocupação, inflação/IPCA, Selic, PIB, dívida pública, salário mínimo, desmatamento, homicídios, preço de combustível, beneficiários de programa social...). period: "AAAA", "AAAA-T4", "AAAA-MM" ou intervalo "INICIO..FIM" (ex.: "2019..2022"); null quando a fala diz "hoje"/"atualmente". kind: level (valor no período), change_abs (variação absoluta; em indicador percentual, pontos percentuais), change_pct (variação relativa %), max/min (recorde). claimed_value: o número afirmado; use negativo só se a fala disser queda explicitamente em uma variação.
- reference: preencha só quando a afirmação é (a) sobre quanto tempo uma pessoa ou um partido ocupou a Presidência da República ("o PT governou 20 dos últimos 24 anos" → type "tempo_no_poder", subject "PT", window_years 24, claimed_value 20, unit "anos") ou (b) sobre votos ou percentual de votos válidos de um candidato num turno de eleição presidencial, com ano E turno DITOS na fala ou no contexto ("no segundo turno de 2022 eu tive 58 milhões de votos" → type "eleicao", subject o candidato, year 2022, round 2, claimed_value 58000000, unit "votos"). Ano ou turno não ditos → year/round null (não presuma a última eleição). qualifier: "mais_de", "menos_de", "quase", "cerca_de" ou "exato", conforme a fala. Sem candidato ou partido explícito (ex.: "50 milhões escolheram a mudança"), reference null.
- time_reference: período resolvido em texto, ou null.

Se não houver nada checável, devolva {"claims": []}.

Exemplos (resumidos):
Fala: "Boa noite a todos, é uma honra estar aqui." → {"claims": []}
Fala: "Eu vou acabar com a fome em dois anos." → tipo "promessa".
Fala: "Hoje o brasileiro não consegue mais comprar carne." → tipo "opiniao_mensuravel"; measurable "consumo de carne bovina por pessoa no Brasil em 2025 e 2026".
Fala: "Ele foi condenado em segunda instância." (contexto: falando de um ex-governador nomeado antes) → tipo "acusacao"; text_normalized com o nome dele, ex.: "O ex-governador Fulano foi condenado em segunda instância."
Fala: "No meu governo o desemprego caiu para 6,6%." (contexto indica o presidente Lula, falando de 2024) → text_normalized "A taxa de desemprego no Brasil foi de 6,6% em 2024, durante o governo Lula."; tipo "estatistica"; indicator {query "desemprego", period "2024", claimed_value 6.6, unit "%", kind "level"}.
Fala: "O desmatamento na Amazônia caiu quase 50% de 2022 para 2023." → tipo "estatistica"; indicator {query "desmatamento Amazônia", period "2022..2023", claimed_value 50, unit "%", kind "change_pct"}; numbers [{value 50, unit "%", raw "quase 50%"}].
Fala: "Ele votou contra a PEC da Transição." (contexto: o senador Flávio Bolsonaro) → text_normalized "O senador Flávio Bolsonaro votou contra a PEC da Transição."; tipo "fato"; indicator null.
Fala: "O PT governou o Brasil em 20 dos últimos 24 anos." → tipo "fato"; reference {type "tempo_no_poder", subject "PT", window_years 24, year null, round null, claimed_value 20, unit "anos", qualifier "exato"}.`;

function toTopic(t: string): Topic {
  const n = t.trim().toLowerCase();
  return (TOPICS as readonly string[]).includes(n) ? (n as Topic) : "outro";
}

/**
 * Tipo da fala (sem acento e sem caixa). Promessa, opinião ou tipo desconhecido ⇒ null
 * (descartar): na dúvida, silêncio — nunca "fato", que escaparia das regras por tipo.
 */
export function toKind(k: string | null | undefined): ClaimKind | null {
  const n = (k ?? "").normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, "_");
  return (CLAIM_KINDS as readonly string[]).includes(n) ? (n as ClaimKind) : null;
}

/**
 * Trava em código para acusação: fala sobre situação judicial ou policial vira
 * "acusacao" mesmo que o modelo a rotule como fato/estatística — a revisão humana
 * obrigatória e o vermelho só com nível 1 não podem depender só do rótulo.
 */
// Situação judicial/policial de uma pessoa. Sem "crime", "facção" ou "fraude" soltos:
// aparecem em estatística de segurança e mandariam essas falas para o editor à toa.
const ACCUSATION_RE =
  /\b(conden\w*|pres[oa]|prisao|reu|re|denunciad\w*|investigad\w*|inquerito|indiciad\w*|inelegiv\w*|absolvid\w*|inocentad\w*|anulad\w*|arquivad\w*|prescri\w*|corrupt\w*|lavagem de dinheiro|propina\w*|peculato|rachadinha\w*|milicia\w*|miliciano\w*|golpista\w*|tentativa de golpe|ladr\w*)\b/;
export function looksLikeAccusation(...texts: string[]): boolean {
  return texts.some((t) => ACCUSATION_RE.test(t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()));
}

// --- Travas de fidelidade (determinísticas; só descartam — na dúvida, silêncio) ---

const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Tem número de verdade? O smart_format do Deepgram escreve o artigo "um/uma" como "1"
 * ("fazer 1 emendinha"): "1" antes de palavra minúscula que não é ordem de grandeza
 * nem "por cento" não conta.
 */
function hasNumber(text: string): boolean {
  return /\d/.test(text.replace(/\b1º?\s+(?!(?:mil|milh|bilh|trilh|por\b|ter[cç]|quart|quint|ponto|d[ií]git|p\.?p))(?=\p{Ll})/gu, ""));
}

/** Pergunta sem núcleo afirmativo: termina em "?", tem pronome interrogativo e nenhum número. */
const INTERROGATIVE = /\b(qual|quais|quem|quanto|quantos|quantas|por que|porque|pra que|onde|quando|como)\b/;
export function isOpenQuestion(original: string): boolean {
  return /\?\s*$/.test(original) && INTERROGATIVE.test(fold(original)) && !hasNumber(original);
}

/** Hipótese/insinuação ("pode ser", "talvez") sem número: não é afirmação de fato. */
const HEDGE = /\b(pode ser|pode estar|podem ser|podem estar|deve estar|talvez|quem sabe|sera que)\b/;
export function isHedged(original: string): boolean {
  return HEDGE.test(fold(original)) && !hasNumber(original);
}

// "ano passado", "este ano", "hoje", "últimos N anos"... autorizam anos perto de hoje
const RELATIVE_TIME = /\b(ano passado|este ano|esse ano|neste ano|nesse ano|ano que vem|proximo ano|hoje|atualmente|agora|mes passado|este mes)\b/;
const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/g;

/**
 * Períodos que a fala nomeia sem dizer o ano ("no governo do seu pai", "quando eu cheguei",
 * "na pandemia"): o prompt manda resolvê-los pelo contexto, então valem os anos que
 * delimitam o período (início e fim: "2019 a 2022"; "quando eu cheguei" = 2003/2023;
 * "quando eu deixei" = 2010/2011). Ano solto no meio ("em 2025, no governo Lula") continua
 * precisando ter sido dito. Mandatos oficiais.
 */
const NAMED_PERIODS: readonly [RegExp, readonly number[]][] = [
  [/\b(governo|gestao|mandato) (do seu pai|do pai dele|bolsonaro|do bolsonaro|jair bolsonaro|do jair|anterior|passado)\b/, [2019, 2022]],
  [
    /\b(meu governo|meus governos|meu mandato|meus mandatos|nosso governo|nossos governos|governo lula|governos lula|governo do lula|governos do pt|governos petistas)\b/,
    [2003, 2010, 2023, 2026],
  ],
  [/\b(quando|desde que) eu (cheguei|assumi|tomei posse|voltei)\b/, [2003, 2023]],
  [/\b(quando|depois que|antes de) eu (deixei|sai)\b/, [2010, 2011]],
  [/\b(atual governo|governo atual|esse governo|este governo|terceiro mandato)\b/, [2023, 2026]],
  [/\bgoverno (dilma|da dilma)\b/, [2011, 2016]],
  [/\bgoverno (temer|do temer)\b/, [2016, 2018]],
  [/\bgoverno (fhc|fernando henrique|do fernando henrique)\b/, [1995, 2002]],
  [/\b(pandemia|covid)\b/, [2020, 2022]],
  [/\b8 de janeiro\b/, [2023]],
];

// "depois de 2010" → 2011; "antes de 2003" → 2002 (só nos campos de período)
const AFTER_YEAR = /\b(?:depois de|apos|desde|a partir de)\s+(?:o ano de\s+)?(19[5-9]\d|20[0-4]\d)\b/g;
const BEFORE_YEAR = /\b(?:antes de|ate)\s+(?:o ano de\s+)?(19[5-9]\d|20[0-4]\d)\b/g;

/**
 * Anos que a normalização (ou o período/indicador/referência) trouxe e que a fala, o
 * segmento e o contexto não dizem. Ano dito por extenso de 2 dígitos ("de 88") vale;
 * "ano passado"/"hoje" autorizam o ano da data e os vizinhos; "últimos N anos", a janela;
 * período nomeado ("no governo do seu pai") autoriza os anos dele, mas só se dito NA
 * PRÓPRIA AFIRMAÇÃO (`own`): no trecho ou no contexto, "quando eu cheguei" de outra frase
 * licenciaria o "2003 a 2010" inventado para "cresceu 7 e meio" (ensaio 2). Nos campos de
 * período (`periodFields`: indicador, referência temporal, eleição) vale também o ano
 * seguinte a "depois de/desde/a partir de AAAA" e o anterior a "antes de/até AAAA".
 */
export function unlicensedYears(
  added: string[],
  sources: string,
  today: string,
  opts: { own?: string; periodFields?: string[] } = {},
): number[] {
  const src = fold(sources);
  const y0 = Number(today.slice(0, 4));
  const relative = RELATIVE_TIME.test(src);
  const windows = [...src.matchAll(/\bultimos (\d{1,2}) anos\b/g)].map((m) => Number(m[1]));
  const own = fold(opts.own ?? "");
  const named = NAMED_PERIODS.filter(([re]) => re.test(own)).flatMap(([, years]) => years);
  const said = [...src.matchAll(YEAR_RE)].map((m) => Number(m[1]));
  const relational = [
    ...[...src.matchAll(AFTER_YEAR)].map((m) => Number(m[1]) + 1),
    ...[...src.matchAll(BEFORE_YEAR)].map((m) => Number(m[1]) - 1),
  ];
  const out = new Set<number>();
  const check = (text: string, period: boolean) => {
    for (const m of text.matchAll(YEAR_RE)) {
      const y = Number(m[1]);
      if (said.includes(y)) continue;
      const yy = String(y % 100).padStart(2, "0");
      if (new RegExp(`\\b(de|em|anos|ano)\\s+${yy}\\b`).test(src)) continue;
      if (relative && Math.abs(y - y0) <= 1) continue;
      if (windows.some((n) => y >= y0 - n && y <= y0)) continue;
      if (named.includes(y)) continue;
      if (period && relational.includes(y)) continue;
      out.add(y);
    }
  };
  for (const text of added) check(text, false);
  for (const text of opts.periodFields ?? []) check(text, true);
  return [...out];
}

// Taxa por período ("ao ano", "em média") muda a afirmação: "cresceu 7,5%" (num ano) não é
// "cresceu 7,5% ao ano" (média de um governo inteiro). Só vale se a fala disser — como taxa:
// "classe média", "ensino médio" ou "relatório" soltos não contam.
const RATE_ADDED = /\b(ao ano|por ano|anualmente|em media|media anual|ao mes|por mes)\b/;
const RATE_SAID =
  /\b(ao ano|por ano|anualmente|a cada ano|cada ano|todo ano|todos os anos|ao mes|por mes|mensalmente|todo mes|todos os meses|em media|na media|media (de|anual|mensal)|anual|anuais|mensal|mensais)\b/;
// juros (Selic, CDI...) se dizem "ao ano" por convenção: não é escopo acrescentado
const RATE_IS_UNIT = /\b(selic|juros|cdi|taxa basica)\b/;
/** A normalização acrescentou taxa anual/média que a fala (e o trecho) não diz. */
export function addsRate(normalized: string, said: string, indicatorQuery: string | null = null): boolean {
  const n = fold(normalized);
  if (RATE_IS_UNIT.test(n) || RATE_IS_UNIT.test(fold(indicatorQuery ?? ""))) return false;
  return RATE_ADDED.test(n) && !RATE_SAID.test(fold(said));
}

/** Eleição citada precisa ter ano e turno ditos (fala, segmento ou contexto). */
export function electionUnderspecified(ref: ReferenceRef | null, sources: string): boolean {
  if (!ref || ref.type !== "eleicao") return false;
  const src = fold(sources);
  const yearSaid = ref.year !== null && new RegExp(`\\b${ref.year}\\b`).test(src);
  const roundSaid = /\b(primeiro|segundo|1o|2o) turno\b/.test(src.replace(/[º°]/g, "o"));
  return !yearSaid || !roundSaid;
}

// Nomes que podem aparecer na afirmação sem estar na fala: candidatos, ex-presidentes e
// instituições que o extrator escreve por extenso a partir de siglas ou pronomes.
const KNOWN_NAME_WORDS = new Set(
  (
    "lula luiz inacio silva flavio bolsonaro jair eduardo carlos michelle dilma rousseff michel temer fernando henrique " +
    "cardoso collor itamar franco haddad geraldo alckmin brasil brasileiro brasileira brasileiros federal federais policia " +
    "banco central supremo tribunal superior eleitoral justica ministerio publico camara deputados senado congresso nacional " +
    "receita caixa economica bolsa familia minha casa vida mais medicos programa governo uniao estado estados unidos rio " +
    "janeiro sao paulo constituicao lei emenda proposta operacao lava jato petrobras previdencia social instituto seguro " +
    "amazonia legal nordeste presidencia republica presidente senador senadora deputado deputada ministro ministra partido " +
    "trabalhadores liberal comando vermelho primeiro capital auxilio plano real reforma tributaria mundial monetario " +
    "internacional fundo nacoes unidas forum seguranca anuario estatistica geografia tesouro conselho comissao parlamentar " +
    "inquerito mista assembleia legislativa distrito defensoria advocacia geral controladoria " +
    // expansões de sigla que o extrator escreve por extenso
    "sistema unico saude contas procuradoria rodoviaria microempreendedor individual agencia inteligencia " +
    "desenvolvimento economico fundo garantia tempo servico consolidacao leis trabalho beneficio prestacao " +
    "continuada teto gastos arcabouco fiscal constitucional microempresa empresa pequeno porte " +
    // prenomes de quem é citado pelo sobrenome ("o Moraes" → "Alexandre de Moraes"; o sobrenome segue exigido)
    "alexandre donald sergio romeu ronaldo gleisi nikolas " +
    // siglas que o extrator escreve como estão ou expande
    "inss pf stf stj tse tcu cgu agu mpf pgr sus ibge ipea pt pl psdb mdb psol pdt psb pp pcc cv cpi cpmi pec mp bc onu fmi " +
    "ocde bndes fgts clt"
  ).split(" "),
);
const CONNECTORS = new Set(["da", "de", "do", "das", "dos", "e"]);

/**
 * Nome próprio (2+ palavras com maiúscula em sequência) que a fala, o segmento e o contexto
 * não trazem e que não é candidato nem instituição conhecida: o extrator inventou.
 */
export function inventedNames(normalized: string, sources: string): string[] {
  const src = new Set(fold(sources).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  // palavra com hífen ("Advocacia-Geral", "Pé-de-Meia") confere parte a parte; sigla
  // ("PIB", "IPCA", "Caged" escrito "CAGED") não é nome de gente
  const known = (w: string) =>
    /^\p{Lu}{2,6}$/u.test(w) ||
    w.split("-").every((p) => p.length < 3 || src.has(fold(p)) || KNOWN_NAME_WORDS.has(fold(p)));
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const caps = run.filter((w) => !CONNECTORS.has(w.toLowerCase()));
    if (caps.length >= 2 && caps.some((w) => !known(w))) out.push(run.join(" "));
    run = [];
  };
  for (const raw of normalized.split(/\s+/)) {
    // pontuação separa ("ministro da Fazenda, Fernando Haddad": não é um nome só)
    if (raw.startsWith("(")) flush();
    const w = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (w && /^\p{Lu}/u.test(w)) run.push(w);
    else if (run.length && CONNECTORS.has(w.toLowerCase())) run.push(w);
    else flush();
    if (/[,;:.!?)]$/.test(raw)) flush();
  }
  flush();
  return out;
}

/** Opinião e previsão só são julgáveis com o dado que as mede. */
const NEEDS_MEASURE: readonly ClaimKind[] = ["opiniao_mensuravel", "previsao"];

const REFERENCE_TYPES: ReferenceRef["type"][] = ["tempo_no_poder", "eleicao"];
const REFERENCE_UNITS: ReferenceRef["unit"][] = ["anos", "votos", "%"];
const QUALIFIERS: ReferenceRef["qualifier"][] = ["exato", "cerca_de", "mais_de", "menos_de", "quase"];

/** Fato de referência só passa inteiro e coerente; qualquer campo fora do padrão ⇒ null. */
export function toReference(raw: ExtractionOutput["claims"][number]["reference"]): ReferenceRef | null {
  if (!raw || !raw.subject.trim() || !Number.isFinite(raw.claimed_value)) return null;
  const type = raw.type.trim() as ReferenceRef["type"];
  const unit = raw.unit.trim().toLowerCase() as ReferenceRef["unit"];
  const q = raw.qualifier.trim().toLowerCase() as ReferenceRef["qualifier"];
  if (!REFERENCE_TYPES.includes(type) || !REFERENCE_UNITS.includes(unit)) return null;
  if (type === "tempo_no_poder" && unit !== "anos") return null;
  if (type === "eleicao" && (unit === "anos" || !raw.year || !(raw.round === 1 || raw.round === 2))) return null;
  return {
    type,
    subject: raw.subject.trim(),
    window_years: type === "tempo_no_poder" && raw.window_years && raw.window_years > 0 ? raw.window_years : null,
    year: type === "eleicao" ? raw.year : null,
    round: type === "eleicao" ? raw.round : null,
    claimed_value: raw.claimed_value,
    unit,
    qualifier: QUALIFIERS.includes(q) ? q : "exato",
  };
}

function toIndicator(raw: ExtractionOutput["claims"][number]["indicator"]): IndicatorRef | null {
  if (!raw || !raw.query.trim()) return null;
  const kind = raw.kind.trim() as IndicatorRef["kind"];
  if (!INDICATOR_KINDS.includes(kind)) return null;
  return {
    query: raw.query.trim(),
    period: raw.period?.trim() || null,
    claimed_value: raw.claimed_value ?? null,
    unit: raw.unit?.trim() || null,
    kind,
  };
}

/** Pós-processamento determinístico: valida, normaliza números e descarta o que não está na fala. */
export function postprocessExtraction(
  out: ExtractionOutput,
  segmentText: string,
  logger: Logger,
  opts: { context?: string; today?: string } = {},
): ExtractedClaim[] {
  const segNorm = normalizeForQuote(segmentText);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const claims: ExtractedClaim[] = [];
  for (const c of out.claims) {
    const original = c.text_original.trim();
    const normalized = c.text_normalized.trim();
    if (!original || !normalized) continue;
    // o trecho precisa estar na fala atual (o modelo não pode inventar afirmação)
    const inSegment = segNorm.includes(normalizeForQuote(original)) || quoteCheck(original, segmentText).verified;
    if (!inSegment) {
      logger("warn", "extract_claim_not_in_segment", { text_original: original });
      continue;
    }
    let kind = toKind(c.tipo);
    const measurable = c.measurable?.trim() || null;
    if (!kind) {
      logger("info", "extract_dropped", { reason: c.tipo.trim().toLowerCase(), text_original: original });
      continue;
    }
    const drop = (reason: string, extra: Record<string, unknown> = {}) =>
      logger("info", "extract_dropped", { reason, kind, text_original: original, text_normalized: normalized, ...extra });
    if (isOpenQuestion(original)) {
      drop("pergunta");
      continue;
    }
    if (isHedged(original)) {
      drop("hipotese");
      continue;
    }
    // o que a pessoa disse = fala atual + transcrição anterior (mesmo falante ou não)
    const sources = `${original}\n${segmentText}\n${opts.context ?? ""}`;
    const reference = toReference(c.reference);
    const indicator = toIndicator(c.indicator);
    const years = unlicensedYears([normalized], sources, today, {
      own: original,
      periodFields: [indicator?.period ?? "", c.time_reference ?? "", reference?.year ? String(reference.year) : ""],
    });
    if (years.length) {
      drop("normalizacao_acrescenta_ano", { years });
      continue;
    }
    if (addsRate(normalized, `${original}\n${segmentText}`, indicator?.query ?? null)) {
      drop("escopo_acrescentado");
      continue;
    }
    // eleição sem ano ou turno vira referência nula em toReference: a fala continua ambígua
    const election = c.reference?.type.trim() === "eleicao";
    if (election && (!reference || electionUnderspecified(reference, sources))) {
      drop("periodo_ambiguo");
      continue;
    }
    const names = inventedNames(normalized, sources);
    if (names.length) {
      drop("nome_inventado", { names });
      continue;
    }
    const kindModel = kind;
    let kindRule = "";
    if ((kind === "fato" || kind === "estatistica") && looksLikeAccusation(original, normalized)) {
      logger("info", "extract_kind_upgraded", { from: kind, to: "acusacao", text_original: original });
      kindRule = `promovida_de_${kind}`;
      kind = "acusacao";
    }
    if (NEEDS_MEASURE.includes(kind) && !measurable) {
      logger("info", "extract_dropped", { reason: "sem_medida", kind, text_original: original });
      continue;
    }
    claims.push({
      text_original: original,
      text_normalized: normalized,
      topic: toTopic(c.topic),
      kind,
      measurable: NEEDS_MEASURE.includes(kind) ? measurable : null,
      numbers: normalizeClaimNumbers(c.numbers),
      indicator,
      reference,
      time_reference: c.time_reference?.trim() || null,
      kind_model: kindModel,
      ...(kindRule ? { kind_rule: kindRule } : {}),
    });
  }
  return claims;
}

export interface ExtractInput {
  text: string;
  /** Transcrição anterior (janela de contexto). */
  context: string;
  speaker_label?: string | null;
  /** YYYY-MM-DD — "hoje" para resolver referências temporais. */
  today: string;
}

/** Monta a mensagem do usuário (a parte variável fica fora do system). */
export function buildExtractMessage(input: ExtractInput): string {
  const speaker = input.speaker_label ? ` locutor="${input.speaker_label}"` : "";
  return [
    `Data da fala: ${input.today}. Contexto: debate eleitoral presidencial de 2026.`,
    `<contexto>\n${input.context.trim() || "(sem contexto)"}\n</contexto>`,
    `<fala_atual${speaker}>\n${input.text.trim()}\n</fala_atual>`,
    "Extraia as afirmações checáveis da fala atual.",
  ].join("\n\n");
}

/**
 * Chama o Haiku com saída estruturada. Qualquer falha (refusal, corte por
 * max_tokens, JSON inválido) vira lista vazia — silêncio.
 */
export async function extractClaims(
  client: AnthropicLike,
  input: ExtractInput,
  logger: Logger,
  usage?: UsageMeter,
): Promise<ExtractedClaim[]> {
  const msg = await client.messages.parse(
    {
      model: MODEL_EXTRACT,
      max_tokens: 2_000,
      // extração é mecânica: sem raciocínio estendido, esforço baixo (latência)
      thinking: { type: "disabled" },
      system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildExtractMessage(input) }],
      output_config: { effort: "low", format: zodOutputFormat(ExtractionSchema) },
    },
    { timeout: TIMEOUTS_MS.extract, maxRetries: 0 },
  );
  usage?.record(anthropicUsageRow(MODEL_EXTRACT, msg.usage));
  if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
    logger("warn", "extract_incomplete", { stop_reason: msg.stop_reason });
    return [];
  }
  if (!msg.parsed_output) {
    logger("warn", "extract_unparsed", { stop_reason: msg.stop_reason });
    return [];
  }
  return postprocessExtraction(msg.parsed_output, input.text, logger, { context: input.context, today: input.today });
}
