// Dados FICTÍCIOS do modo demonstração (/ao-vivo/demo e /admin/demo).
// Participantes genéricos ("Candidato A/B") e fontes em example.org: nada aqui
// atribui frases a pessoas reais nem cita documentos reais.

import type { CaptureAgent, CaptureMachine, Debate } from "@actually/db";
import type { Attribution, FeedAlert, FeedEvidence } from "../feed";

export const DEMO_DEBATE = {
  id: "00000000-0000-4000-8000-000000000000",
  slug: "demo",
  title: "Debate de demonstração",
  status: "live" as const,
};

export const DEMO_ATTRIBUTION: Attribution = {
  show: true,
  speakers: { S0: "Candidato A", S1: "Candidato B", S2: "Mediação" },
};

interface DemoTemplate {
  verdict: FeedAlert["verdict"];
  speaker: string | null;
  claim: string;
  correction: string;
  summary: string;
  evidence: FeedEvidence[];
  /** Índice do template original quando é repetição. */
  repeatOf?: number;
}

const ev = (source_name: string, path: string, quote: string, tier: 1 | 2 = 1): FeedEvidence => ({
  url: `https://example.org/${path}`,
  source_name,
  source_tier: tier,
  quote,
  evidence_type: tier === 1 ? "indicator" : "document",
  published_at: null,
});

export const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    verdict: "contradito",
    speaker: "S0",
    claim: "A taxa de desemprego caiu pela metade nos últimos dois anos.",
    correction: "A série oficial mostra queda de 9,1% para 7,8% no período — cerca de 14%, não 50%.",
    summary: "Queda real foi bem menor que a afirmada.",
    evidence: [
      ev(
        "Instituto de Estatística (exemplo)",
        "estatisticas/desocupacao",
        "A taxa de desocupação foi estimada em 7,8% no trimestre, ante 9,1% no mesmo trimestre de dois anos antes.",
      ),
    ],
  },
  {
    verdict: "impreciso",
    speaker: "S1",
    claim: "O programa de transferência de renda atende 30 milhões de famílias.",
    correction: "Os dados oficiais indicam 21 milhões de famílias atendidas no último mês.",
    summary: "Número exagerado em relação ao cadastro oficial.",
    evidence: [
      ev(
        "Portal de Transparência (exemplo)",
        "transparencia/programa-renda",
        "No mês de referência, 21,0 milhões de famílias receberam o benefício.",
      ),
    ],
  },
  {
    verdict: "contradito",
    speaker: null,
    claim: "O desmatamento aumentou 80% no último ano.",
    correction: "A medição anual por satélite aponta queda de 22% no mesmo período.",
    summary: "Direção da mudança está invertida.",
    evidence: [
      ev(
        "Instituto de Pesquisas Espaciais (exemplo)",
        "monitoramento/desmatamento-anual",
        "A taxa consolidada indica redução de 22% em relação ao período anterior.",
      ),
      ev(
        "Agência de checagem (exemplo)",
        "checagens/desmatamento",
        "Os dados oficiais não sustentam aumento; houve redução no período citado.",
      ),
    ],
  },
  {
    verdict: "impreciso",
    speaker: "S1",
    claim: "A inflação do ano passado foi a menor da história.",
    correction: "Foi a menor dos últimos 6 anos, mas não da série histórica.",
    summary: "Recorte de tempo omitido.",
    evidence: [
      ev(
        "Banco Central (exemplo)",
        "indicadores/inflacao-anual",
        "O índice acumulado em 12 meses foi o menor desde seis anos antes; houve valores inferiores na série.",
      ),
    ],
  },
  {
    verdict: "contradito",
    speaker: "S0",
    claim: "O desemprego caiu pela metade, como eu já disse.",
    correction: "A série oficial mostra queda de 9,1% para 7,8% no período — cerca de 14%, não 50%.",
    summary: "Afirmação repetida.",
    evidence: [
      ev(
        "Instituto de Estatística (exemplo)",
        "estatisticas/desocupacao",
        "A taxa de desocupação foi estimada em 7,8% no trimestre, ante 9,1% no mesmo trimestre de dois anos antes.",
      ),
    ],
    repeatOf: 0,
  },
  {
    verdict: "impreciso",
    speaker: "S0",
    claim: "O salário mínimo teve aumento real de 10% neste ano.",
    correction: "O reajuste acima da inflação foi de 2,8%; os 10% são o reajuste nominal acumulado.",
    summary: "Confusão entre aumento nominal e real.",
    evidence: [
      ev(
        "Diário Oficial (exemplo)",
        "legislacao/salario-minimo",
        "O valor representa reajuste nominal de 10,0%, o que corresponde a ganho real de 2,8% descontada a inflação.",
      ),
    ],
  },
];

export const DEMO_TRANSCRIPT: { speaker: string | null; text: string }[] = [
  { speaker: "S2", text: "Boa noite. Vamos ao primeiro bloco, sobre economia e emprego." },
  { speaker: "S0", text: "A taxa de desemprego caiu pela metade nos últimos dois anos, e isso é resultado do nosso trabalho." },
  { speaker: "S1", text: "O programa de transferência de renda atende 30 milhões de famílias, e nós vamos ampliar." },
  { speaker: "S2", text: "Tempo esgotado. Candidato A, sua réplica." },
  { speaker: "S0", text: "Na área ambiental, o desmatamento aumentou 80% no último ano, segundo o que vimos." },
  { speaker: "S1", text: "A inflação do ano passado foi a menor da história do país." },
  { speaker: "S0", text: "O desemprego caiu pela metade, como eu já disse." },
  { speaker: "S0", text: "E o salário mínimo teve aumento real de 10% neste ano." },
];

/** Instancia o template `i` como um alerta publicado agora. */
export function demoAlert(i: number, seq: number, at: Date, originals: Map<number, FeedAlert>): FeedAlert {
  const t = DEMO_TEMPLATES[i % DEMO_TEMPLATES.length]!;
  const iso = at.toISOString();
  const orig = t.repeatOf !== undefined ? originals.get(t.repeatOf) : undefined;
  return {
    id: `demo-${seq}`,
    debate_id: DEMO_DEBATE.id,
    claim_id: `demo-claim-${seq}`,
    verification_id: `demo-verif-${seq}`,
    verdict: t.verdict,
    status: "published",
    claim_text: t.claim,
    summary: t.summary,
    correction: t.correction,
    speaker_label: t.speaker,
    is_repeat: t.repeatOf !== undefined,
    repeat_of: orig?.id ?? null,
    segment_t_end: null,
    created_at: iso,
    published_at: iso,
    reviewed_by: null,
    reviewed_at: null,
    reject_reason: null,
    evidence: t.evidence,
    person: t.speaker && DEMO_ATTRIBUTION.show ? (DEMO_ATTRIBUTION.speakers[t.speaker] ?? null) : null,
    repeat_verified_at: orig?.created_at ?? null,
  };
}

// --- /admin/demo -------------------------------------------------------------

export function demoAdminData(now: number) {
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const debate: Debate = {
    id: DEMO_DEBATE.id,
    slug: "demo",
    title: DEMO_DEBATE.title,
    youtube_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    status: "live",
    settings: {},
    created_at: ago(86400),
    started_at: ago(1800),
    ended_at: null,
    scheduled_at: ago(1800),
  };
  const agents: CaptureAgent[] = [
    {
      id: "00000000-0000-4000-8000-0000000000a1",
      debate_id: debate.id,
      name: "notebook-casa",
      source: "youtube",
      role: "primary",
      active: false,
      last_heartbeat: ago(42),
      created_at: ago(2000),
    },
    {
      id: "00000000-0000-4000-8000-0000000000a2",
      debate_id: debate.id,
      name: "desktop-escritorio",
      source: "device",
      role: "standby",
      active: true,
      last_heartbeat: ago(1),
      created_at: ago(1900),
    },
  ];
  const machines: CaptureMachine[] = [
    {
      id: "00000000-0000-4000-8000-0000000000b1",
      name: "notebook-casa",
      platform: "darwin-arm64",
      version: "0.1.0",
      desired: {
        state: "running",
        debate_slug: "demo",
        source: "youtube",
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        role: "primary",
      },
      reported: {
        state: "error",
        agent_id: agents[0]!.id,
        active: false,
        debate_slug: "demo",
        source: "youtube",
        last_segment_at: ago(45),
        segments_sent: 412,
        audio_level_db: null,
        reconnects: 3,
        error: "yt-dlp: HTTP 403 ao baixar o manifesto HLS (tentativa 3/5)",
        log_tail: [
          "22:31:02 segmento 412 enviado (accepted)",
          "22:31:40 ffmpeg: fim inesperado do stream",
          "22:31:41 reconectando ao YouTube (1/5)…",
          "22:31:52 yt-dlp: HTTP 403",
        ],
      },
      last_seen: ago(38),
      desired_updated_at: ago(2100),
      desired_updated_by: null,
      created_at: ago(90000),
    },
    {
      id: "00000000-0000-4000-8000-0000000000b2",
      name: "desktop-escritorio",
      platform: "win32-x64",
      version: "0.1.0",
      desired: { state: "running", debate_slug: "demo", source: "device", device: "Stereo Mix", role: "standby" },
      reported: {
        state: "running",
        agent_id: agents[1]!.id,
        active: true,
        debate_slug: "demo",
        source: "device",
        last_segment_at: ago(3),
        segments_sent: 398,
        audio_level_db: -21,
        reconnects: 0,
        error: null,
        log_tail: ["22:32:10 promovido a agente ativo (failover)", "22:32:14 segmento 398 enviado (accepted)"],
      },
      last_seen: ago(1),
      desired_updated_at: ago(2000),
      desired_updated_by: null,
      created_at: ago(90000),
    },
    {
      id: "00000000-0000-4000-8000-0000000000b3",
      name: "mini-pc-reserva",
      platform: "linux-x64",
      version: "0.1.0",
      desired: {
        state: "running",
        debate_slug: "demo",
        source: "youtube",
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        role: "standby",
        start_at: new Date(now + 15 * 60_000).toISOString(),
      },
      reported: { state: "waiting_start", reconnects: 0, log_tail: ["aguardando start_at"] },
      last_seen: ago(2),
      desired_updated_at: ago(600),
      desired_updated_by: null,
      created_at: ago(90000),
    },
  ];
  return { debate, agents, machines };
}
