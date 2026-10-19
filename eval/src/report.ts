// Renderização em markdown (pura).
import type { EvalMetrics, LatencyStat, PrecisionRecall, RateStat, SliceSummary } from "./metrics";
import type { SweepPoint } from "./thresholds";

export function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`;
}

export function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)} ms`;
}

export function table(header: string[], rows: (string | number)[][]): string {
  const esc = (c: string | number) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${header.map(esc).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

function prRow(name: string, p: PrecisionRecall): (string | number)[] {
  return [name, p.predicted, p.expected, p.tp, p.fp, p.fn, pct(p.precision), pct(p.recall)];
}

function rateRow(name: string, r: RateStat): (string | number)[] {
  return [name, r.n, r.hits, pct(r.rate)];
}

function latencyTable(lat: Record<string, LatencyStat>): string {
  return table(
    ["Etapa", "n", "p50", "p95", "máx"],
    Object.entries(lat).map(([k, s]) => [k, s.n, ms(s.p50), ms(s.p95), ms(s.max)]),
  );
}

function sliceTable(title: string, slices: Record<string, SliceSummary>): string {
  return table(
    [title, "n", "esp. vermelho", "esp. amarelo", "emit. vermelho", "emit. amarelo", "prec. vermelho", "recall vermelho", "prec. alerta", "recall alerta", "falso alarme"],
    Object.entries(slices).map(([k, s]) => [
      k, s.n, s.expected_red, s.expected_yellow, s.predicted_red, s.predicted_yellow,
      pct(s.red_precision), pct(s.red_recall), pct(s.alert_precision), pct(s.alert_recall), pct(s.false_alarm_rate),
    ]),
  );
}

const LABEL: Record<string, string> = { red: "vermelho", yellow: "amarelo", none: "— nenhum" };

export interface ReportMeta {
  data_file: string;
  started_at: string;
  settings: Record<string, unknown>;
  concurrency: number;
  red_precision_target: number;
}

export function renderReport(m: EvalMetrics, meta: ReportMeta): string {
  const out: string[] = [];
  const redOk = m.red.precision !== null && m.red.precision >= meta.red_precision_target;
  out.push(`# Relatório de avaliação`);
  out.push("");
  out.push(`- Conjunto: \`${meta.data_file}\` — ${m.n_items} itens (${m.n_synthetic} sintéticos), ${m.n_decisions} afirmações extraídas`);
  out.push(`- Início: ${meta.started_at} · concorrência ${meta.concurrency}`);
  out.push(`- Settings: \`${JSON.stringify(meta.settings)}\``);
  if (m.n_synthetic === m.n_items && m.n_items > 0) {
    out.push(`- ATENÇÃO: Só itens sintéticos: este run testa o encanamento, **não** mede qualidade.`);
  }
  if (m.silence.errors.hits > 0) {
    out.push(`- ATENÇÃO: ${m.silence.errors.hits} item(ns) com erro no pipeline (contados como silêncio).`);
  }
  out.push("");
  out.push(`## Resumo`);
  out.push("");
  out.push(
    table(
      ["Métrica", "Valor", "Meta"],
      [
        ["Precisão vermelho", pct(m.red.precision), `≥ ${pct(meta.red_precision_target, 0)} ${m.red.predicted === 0 ? "(nenhum emitido)" : redOk ? "(ok)" : "(abaixo da meta)"}`],
        ["Recall vermelho", pct(m.red.recall), "—"],
        ["Precisão amarelo (estrita / tolerante)", `${pct(m.yellow.precision)} / ${pct(m.yellow.lenient_precision)}`, "—"],
        ["Falso alarme em verdadeiras + não checáveis", pct(m.false_alarm.on_true_or_uncheckable.rate), "o menor possível"],
        ["vermelho onde nenhum alerta era esperado", `${m.false_alarm.red_on_no_alert_expected.hits}`, "0"],
        ["Taxa de silêncio (geral)", pct(m.silence.overall.rate), "—"],
        ["Latência total p50 / p95", `${ms(m.latency_ms["total (item, parede)"]?.p50)} / ${ms(m.latency_ms["total (item, parede)"]?.p95)}`, "p50 < 5 s"],
      ],
    ),
  );
  out.push("");
  out.push(`## Precisão e recall (por item)`);
  out.push("");
  out.push(`Cada item é avaliado pelo alerta mais severo entre as afirmações extraídas da fala.`);
  out.push("");
  out.push(
    table(
      ["Nível", "emitidos", "esperados", "VP", "FP", "FN", "precisão", "recall"],
      [prRow("vermelho", m.red), prRow("amarelo", m.yellow), prRow("qualquer alerta", m.any_alert)],
    ),
  );
  out.push("");
  out.push(`Precisão tolerante do amarelo (amarelo emitido onde se esperava vermelho conta como acerto): ${pct(m.yellow.lenient_precision)}.`);
  out.push("");
  out.push(`### Matriz de confusão (linhas = esperado, colunas = emitido)`);
  out.push("");
  const keys = ["red", "yellow", "none"] as const;
  out.push(table(["esperado \\ emitido", ...keys.map((k) => LABEL[k]!)], keys.map((e) => [LABEL[e]!, ...keys.map((p) => m.confusion[e][p])])));
  out.push("");
  out.push(`## Falso alarme`);
  out.push("");
  out.push(
    table(
      ["Grupo", "n", "com alerta", "taxa"],
      [
        rateRow("Afirmações verdadeiras (confirmado)", m.false_alarm.on_true),
        rateRow("Falas não checáveis", m.false_alarm.on_uncheckable),
        rateRow("Verdadeiras + não checáveis", m.false_alarm.on_true_or_uncheckable),
        rateRow("Qualquer item sem alerta esperado", m.false_alarm.on_no_alert_expected),
        rateRow("vermelho em item sem alerta esperado", m.false_alarm.red_on_no_alert_expected),
      ],
    ),
  );
  out.push("");
  out.push(`## Silêncio`);
  out.push("");
  out.push(
    table(
      ["Grupo", "n", "em silêncio", "taxa"],
      [
        rateRow("Todos os itens", m.silence.overall),
        rateRow("Itens que deveriam alertar", m.silence.on_expected_alert),
        rateRow("Itens com erro no pipeline", m.silence.errors),
      ],
    ),
  );
  out.push("");
  out.push(`### Motivos de silêncio (por afirmação)`);
  out.push("");
  const reasons = Object.entries(m.silence_reasons);
  out.push(reasons.length ? table(["silence_reason", "afirmações"], reasons) : "_Nenhuma afirmação silenciada._");
  out.push("");
  out.push(`## Latência`);
  out.push("");
  out.push(`Por etapa: máximo entre as afirmações do item (caminho crítico). Total: tempo de parede de \`evaluateText\`. Não inclui STT nem entrega — use \`latency-report\` no ensaio para o ponta a ponta.`);
  out.push("");
  out.push(latencyTable(m.latency_ms));
  out.push("");
  out.push(`## Neutralidade — por speaker`);
  out.push("");
  out.push(`Mesmo pipeline e thresholds para todos. Diferenças grandes de falso alarme ou precisão entre candidatos precisam ser investigadas antes do debate.`);
  out.push("");
  out.push(sliceTable("Speaker", m.by_speaker));
  out.push("");
  out.push(`## Por tópico`);
  out.push("");
  out.push(sliceTable("Tópico", m.by_topic));
  out.push("");
  out.push(`## Erros (${m.errors.length})`);
  out.push("");
  if (m.errors.length === 0) out.push("_Nenhum erro._");
  for (const e of m.errors) {
    out.push(`### ${e.kind} — \`${e.item_id}\` (${e.speaker}${e.topic ? `, ${e.topic}` : ""})`);
    out.push("");
    out.push(`> ${e.text}`);
    out.push("");
    out.push(`- Esperado: ${LABEL[e.expected.alert ?? "none"]} (veredito ${e.expected.verdict ?? "não checável"}) · Emitido: ${LABEL[e.predicted ?? "none"]}`);
    if (e.reference_urls.length) out.push(`- Referência: ${e.reference_urls.join(", ")}`);
    if (e.error) out.push(`- Erro do pipeline: \`${e.error}\``);
    if (!e.error && e.decisions.length === 0) out.push(`- Nenhuma afirmação extraída.`);
    for (const d of e.decisions) {
      out.push(
        `- Afirmação: “${d.claim}” → ${d.verdict}, score ${d.final_score.toFixed(3)}, camada ${d.layer ?? "—"}, alerta ${d.alert ?? "nenhum"}${d.silence_reason ? ` (silêncio: ${d.silence_reason})` : ""}`,
      );
      if (d.correction) out.push(`  - Correção: ${d.correction}`);
      for (const ev of d.evidence) {
        out.push(`  - [tier ${ev.source_tier}${ev.quote_verified ? ", citação verificada" : ", citação NÃO verificada"}] ${ev.source_name} — ${ev.url} — “${ev.quote.slice(0, 300)}”`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export function renderSweep(opts: {
  decisions_file: string;
  base: { t_red: number; t_yellow: number; web_penalty: number };
  agreement: { n: number; agree: number; rate: number | null };
  target_red: number;
  target_yellow: number;
  byPenalty: { web_penalty: number; red: SweepPoint[]; recRed: SweepPoint | null; yellow: SweepPoint[]; recYellow: SweepPoint | null }[];
}): string {
  const out: string[] = [];
  out.push(`# Varredura de thresholds`);
  out.push("");
  out.push(`- Decisões: \`${opts.decisions_file}\` (sem chamar modelos)`);
  out.push(`- Thresholds do run original: t_red=${opts.base.t_red}, t_yellow=${opts.base.t_yellow}, web_penalty=${opts.base.web_penalty}`);
  out.push(`- Concordância da regra local com o pipeline nesses thresholds: ${opts.agreement.agree}/${opts.agreement.n} (${pct(opts.agreement.rate)})${opts.agreement.rate !== null && opts.agreement.rate < 1 ? " ATENÇÃO: score.ts tem regras que a varredura não reproduz — confira antes de usar a recomendação." : ""}`);
  out.push(`- Alvo: precisão vermelho ≥ ${pct(opts.target_red, 0)}; precisão amarelo tolerante ≥ ${pct(opts.target_yellow, 0)}`);
  out.push("");
  out.push(`As regras duras (citação verificada; fonte tier ≤ 2 para vermelho) independem do threshold: nenhum valor faz passar uma afirmação que as viola. A recomendação é o **menor** threshold cuja precisão atinge o alvo e se mantém em todos os thresholds acima dele.`);
  out.push("");
  for (const b of opts.byPenalty) {
    out.push(`## web_penalty = ${b.web_penalty}`);
    out.push("");
    out.push(
      b.recRed
        ? `**Recomendado t_red = ${b.recRed.t_red}** — precisão ${pct(b.recRed.precision)}, cobertura ${pct(b.recRed.recall)}, ${b.recRed.emitted} vermelhos.`
        : `**Nenhum t_red atinge o alvo.** Mantenha o default conservador e revise os erros; considere HITL obrigatório.`,
    );
    out.push("");
    out.push(table(["t_red", "vermelhos", "precisão", "cobertura (recall)"], b.red.map((p) => [p.t_red.toFixed(2), p.emitted, pct(p.precision), pct(p.recall)])));
    out.push("");
    out.push(
      b.recYellow
        ? `**Recomendado t_yellow = ${b.recYellow.t_yellow}** (com t_red=${b.recYellow.t_red}) — precisão tolerante ${pct(b.recYellow.lenient_precision)}, estrita ${pct(b.recYellow.precision)}, cobertura ${pct(b.recYellow.recall)}.`
        : `**Nenhum t_yellow atinge o alvo.**`,
    );
    out.push("");
    out.push(
      table(
        ["t_yellow", "amarelos", "precisão estrita", "precisão tolerante", "cobertura (recall)"],
        b.yellow.map((p) => [p.t_yellow.toFixed(2), p.emitted, pct(p.precision), pct(p.lenient_precision), pct(p.recall)]),
      ),
    );
    out.push("");
  }
  return out.join("\n");
}
