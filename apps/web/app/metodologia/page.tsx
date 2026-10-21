import { DEFAULT_SETTINGS, SOURCE_TIERS, type SourceTier } from "@actually/db";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CONTACT, contactHref } from "@/lib/env";

export const metadata: Metadata = {
  title: "Metodologia",
  description: "Como a checagem automatizada funciona, quais fontes usa, quando emite alertas e quais são seus limites.",
};

const TIER_TEXT: Record<SourceTier, { title: string; desc: string }> = {
  1: { title: "Tier 1", desc: "Dado oficial primário e checagem profissional" },
  2: { title: "Tier 2", desc: "Imprensa de referência e academia" },
  3: { title: "Tier 3", desc: "Imprensa geral" },
  4: { title: "Tier 4", desc: "Qualquer outra fonte — nunca sustenta um alerta sozinha" },
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-base leading-relaxed">{children}</div>
    </section>
  );
}

export default function MetodologiaPage() {
  const s = DEFAULT_SETTINGS;
  const contact = contactHref();
  const byTier = ([1, 2, 3] as SourceTier[]).map((t) => ({ tier: t, rows: SOURCE_TIERS.filter((r) => r.tier === t) }));

  return (
    <article className="mx-auto max-w-3xl px-4 py-8">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Metodologia</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Como a checagem ao vivo funciona</h1>
      <p className="mt-3 text-base text-muted">
        Prioridades, nesta ordem: <strong className="text-fg">precisão</strong>, latência e cobertura. Na dúvida, o
        sistema fica em silêncio. Nenhum alerta é publicado sem fonte.
      </p>

      <nav aria-label="Nesta página" className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm">
        <ol className="grid gap-1 sm:grid-cols-2">
          {[
            ["etapas", "Etapas"],
            ["fontes", "Camadas de fontes"],
            ["tiers", "Confiabilidade das fontes"],
            ["limiares", "Limiares de confiança"],
            ["revisao", "Revisão humana"],
            ["repeticao", "Trava de repetição"],
            ["neutralidade", "Neutralidade"],
            ["limitacoes", "Limitações"],
            ["erro", "Como reportar um erro"],
          ].map(([id, t]) => (
            <li key={id}>
              <a href={`#${id}`} className="underline">
                {t}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Section id="etapas" title="Etapas">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Captura e transcrição.</strong> O áudio da transmissão oficial é transcrito automaticamente, em
            trechos de alguns segundos.
          </li>
          <li>
            <strong>Filtro.</strong> Só seguem frases com afirmação checável (números, fatos, datas, votos, leis).
            Opiniões, promessas, ataques pessoais, perguntas, hipóteses (“pode ser”, “talvez”) e falas da mediação
            são ignorados.
          </li>
          <li>
            <strong>Extração.</strong> Cada afirmação é isolada e reescrita de forma autocontida, usando o contexto do
            último minuto da fala. A reescrita não pode dizer mais do que a fala: se acrescenta um ano, um período, o
            turno de uma eleição ou um nome que ninguém disse, é descartada.
          </li>
          <li>
            <strong>Busca de evidências</strong> nas camadas de fontes descritas abaixo.
          </li>
          <li>
            <strong>Verificação.</strong> Um modelo de linguagem compara a afirmação com as evidências e propõe um
            veredito. O trecho citado da fonte é então conferido <em>por programa</em>: ele precisa existir, de fato,
            no documento original. Números de indicadores oficiais são comparados em código. Não valem como
            evidência o boato que uma checagem reproduz para desmentir, a fala ou alegação de candidato, defesa ou
            partido relatada pela matéria, voto vencido e manchetes de outras matérias; em situação judicial, vale a
            informação mais recente.
          </li>
          <li>
            <strong>Pontuação e decisão.</strong> A confiança final combina a confiança do modelo, a qualidade da
            fonte, a concordância entre camadas e a citação verificada. Abaixo do limiar, nada é publicado
            sem revisão humana.
          </li>
        </ol>
        <p>Os alertas têm dois níveis:</p>
        <ul className="space-y-1 pl-1">
          <li>
            <span aria-hidden="true">🔴</span> <strong>Contradito pelas fontes</strong> — as fontes indicam o contrário
            do que foi dito.
          </li>
          <li>
            <span aria-hidden="true">🟡</span> <strong>Impreciso</strong> — há base, mas com número, período ou recorte
            errado.
          </li>
        </ul>
        <p>Afirmações confirmadas ou inconclusivas não geram alerta.</p>
      </Section>

      <Section id="fontes" title="Camadas de fontes">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Checagens já publicadas</strong> por agências profissionais de checagem.
          </li>
          <li>
            <strong>Indicadores oficiais</strong> (IBGE, Banco Central, INPE, Tesouro, entre outros), consultados de
            forma estruturada: o valor e o período são comparados diretamente.
          </li>
          <li>
            <strong>Documentos</strong>: programas de governo registrados no TSE, debates e entrevistas anteriores,
            votações e discursos oficiais, legislação.
          </li>
          <li>
            <strong>Busca na web</strong>, restrita a domínios de tier 1 e 2, usada só quando as camadas anteriores não
            bastam — e com exigência de confiança maior. As páginas que ela encontra passam a fazer parte da base, para
            as próximas checagens.
          </li>
        </ol>
      </Section>

      <Section id="tiers" title="Confiabilidade das fontes">
        <p>Cada domínio tem um tier. Um alerta vermelho exige fonte de tier 1 ou 2 com trecho verificado.</p>
        <div className="space-y-4">
          {byTier.map(({ tier, rows }) => (
            <div key={tier} className="rounded-xl border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold">
                {TIER_TEXT[tier].title} — <span className="font-normal text-muted">{TIER_TEXT[tier].desc}</span>
              </h3>
              <p className="mt-2 text-sm text-muted">{[...new Set(rows.map((r) => r.name))].join(" · ")}</p>
            </div>
          ))}
          <div className="rounded-xl border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">
              {TIER_TEXT[4].title} — <span className="font-normal text-muted">{TIER_TEXT[4].desc}</span>
            </h3>
          </div>
        </div>
      </Section>

      <Section id="limiares" title="Limiares de confiança">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Vermelho (contradito): pontuação final mínima de <strong>{pct(s.t_red)}</strong>, fonte tier 1–2 e
            citação verificada.
          </li>
          <li>
            Amarelo (impreciso): pontuação final mínima de <strong>{pct(s.t_yellow)}</strong>.
          </li>
          <li>
            Evidência vinda da busca na web: o limiar sobe <strong>{Math.round(s.web_penalty * 100)} pontos</strong>.
          </li>
        </ul>
        <p className="text-sm text-muted">
          Valores padrão, calibrados em um conjunto de teste rotulado; a equipe pode ajustá-los durante o debate, sempre
          igualmente para todos os participantes.
        </p>
      </Section>

      <Section id="revisao" title="Revisão humana">
        <p>
          Alertas vermelhos passam por um editor humano antes de aparecer (chave ligada por padrão). O editor vê a
          afirmação, a fonte e o trecho da transcrição e aprova, rejeita ou ajusta o texto. Nenhum alerta é publicado
          automaticamente por tempo esgotado. A mesma revisão pode ser ligada para os amarelos.
        </p>
        <p>
          Um vermelho de fato ou estatística que fica logo abaixo do limiar (até 5 pontos) não é publicado
          automaticamente: vai para o editor, com a revisão ligada ou não, e só sai se ele aprovar.
        </p>
        <p>
          Independentemente da revisão, o banco de dados recusa publicar qualquer correção sem ao menos uma fonte com
          link e trecho verificado.
        </p>
      </Section>

      <Section id="repeticao" title="Trava de repetição">
        <p>
          Afirmações repetidas não são verificadas de novo: o sistema reconhece a repetição (mesmo texto ou sentido
          muito próximo <em>e</em> os mesmos números) e reaproveita o veredito anterior, marcando o alerta como
          “Repetido — já verificado às HH:MM”. Afirmações parecidas com números diferentes são tratadas como novas.
        </p>
      </Section>

      <Section id="neutralidade" title="Neutralidade">
        <ul className="list-disc space-y-1 pl-5">
          <li>Mesmo processo, mesmas fontes e mesmos limiares para todos os participantes.</li>
          <li>
            Por padrão, os alertas não dizem quem falou (“Afirmação feita no debate”). O nome só aparece quando a
            identificação da voz foi confirmada por um editor.
          </li>
          <li>A equipe acompanha a contagem de alertas por participante para detectar desequilíbrios do sistema.</li>
          <li>O visual não usa cores associadas a partidos.</li>
        </ul>
      </Section>

      <Section id="limitacoes" title="Limitações">
        <ul className="list-disc space-y-1 pl-5">
          <li>A transcrição automática pode errar palavras, números e quem falou.</li>
          <li>O modelo pode interpretar mal o contexto, ironia ou uma afirmação incompleta.</li>
          <li>A base de fontes é finita: muitas afirmações não são checadas — ausência de alerta não significa que a fala é verdadeira.</li>
          <li>
            Os alertas chegam em geral de 10 a 20 segundos depois da fala (mais, se houver revisão humana): buscar e
            conferir a fonte leva tempo, e preferimos chegar um pouco depois a errar.
          </li>
          <li>Dados oficiais podem ser revisados depois de publicados.</li>
        </ul>
      </Section>

      <Section id="erro" title="Como reportar um erro">
        {contact ? (
          <p>
            Encontrou um alerta errado? Escreva para{" "}
            <a href={contact} className="underline">
              {CONTACT.replace(/^mailto:/i, "")}
            </a>{" "}
            com o horário do alerta e o que está errado. Erros confirmados são corrigidos e registrados.
          </p>
        ) : (
          <p>O canal para reportar erros será divulgado nesta página.</p>
        )}
      </Section>

      <p className="mt-10">
        <Link href="/" className="underline">
          ← Voltar aos debates
        </Link>
      </p>
    </article>
  );
}
