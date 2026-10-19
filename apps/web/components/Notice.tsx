import type { ReactNode } from "react";

/** Mensagem de erro/estado em página inteira (ex.: Supabase não configurado). */
export function Notice({ title, children, tone = "neutral" }: { title: string; children?: ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div
        role={tone === "warn" ? "alert" : undefined}
        className={`rounded-xl border p-5 ${
          tone === "warn" ? "border-yellow-border bg-yellow-bg text-yellow-fg" : "border-border bg-surface"
        }`}
      >
        <h1 className="text-lg font-semibold">{title}</h1>
        {children ? <div className="mt-2 text-sm leading-relaxed">{children}</div> : null}
      </div>
    </div>
  );
}
