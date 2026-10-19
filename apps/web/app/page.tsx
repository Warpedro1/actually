import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { SUPABASE_MISSING_MESSAGE } from "@/lib/env";
import { listDebates } from "@/lib/server/debates";

export const revalidate = 15;

const STATUS = {
  live: { text: "Ao vivo", cls: "border-red-border bg-red-bg text-red-fg" },
  scheduled: { text: "Agendado", cls: "border-border bg-surface-2 text-muted" },
  ended: { text: "Encerrado", cls: "border-border bg-surface-2 text-muted" },
} as const;

export default async function Home() {
  const res = await listDebates();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Checagem ao vivo dos debates</h1>
      <p className="mt-2 text-base text-muted">
        Durante o debate, um sistema automatizado verifica afirmações checáveis contra fontes oficiais, checagens
        profissionais e imprensa de referência. Cada alerta mostra a fonte. Pode errar — confira sempre.
      </p>

      <section aria-labelledby="debates" className="mt-8">
        <h2 id="debates" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Debates
        </h2>

        {!res.ok ? (
          <p role="alert" className="mt-3 rounded-lg border border-yellow-border bg-yellow-bg p-3 text-sm text-yellow-fg">
            {res.reason === "unconfigured" ? SUPABASE_MISSING_MESSAGE : `Não foi possível carregar os debates: ${res.message}`}
          </p>
        ) : res.data.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nenhum debate cadastrado ainda.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {res.data.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/ao-vivo/${d.slug}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 no-underline hover:border-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.title}</span>
                    <span className="block text-xs text-muted">
                      {d.scheduled_at ? `Início previsto: ${formatDateTime(d.scheduled_at)}` : "Horário a confirmar"}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS[d.status].cls}`}>
                    {STATUS[d.status].text}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-sm text-muted">
          Quer ver como funciona? Abra a{" "}
          <Link href="/ao-vivo/demo" className="underline">
            demonstração com dados fictícios
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
