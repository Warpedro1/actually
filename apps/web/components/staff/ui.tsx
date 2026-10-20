// Primitivas visuais das áreas restritas (editor/admin).
import type { ComponentProps, ReactNode } from "react";

export function Card({ title, actions, children, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id && title ? `${id}-title` : undefined} className="rounded-xl border border-border bg-surface p-4">
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? (
            <h2 id={id ? `${id}-title` : undefined} className="text-base font-semibold">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANT: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:opacity-90",
  secondary: "border border-border bg-surface text-fg hover:bg-surface-2",
  danger: "border border-red-border bg-red-bg text-red-fg hover:opacity-90",
  ghost: "text-muted hover:text-fg",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
    />
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

export const inputCls =
  "min-h-10 w-full rounded-lg border border-border bg-bg px-3 py-2 text-base text-fg placeholder:text-muted sm:text-sm";

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-border bg-red-bg px-3 py-2 text-sm text-red-fg">
      {children}
    </p>
  );
}

export function OkText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="status" className="rounded-lg border border-border bg-ok-bg px-3 py-2 text-sm text-ok-fg">
      {children}
    </p>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad"; children: ReactNode }) {
  const cls = {
    neutral: "border-border bg-surface-2 text-muted",
    ok: "border-transparent bg-ok-bg text-ok-fg",
    warn: "border-yellow-border bg-yellow-bg text-yellow-fg",
    bad: "border-red-border bg-red-bg text-red-fg",
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

export function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
