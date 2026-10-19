import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-4">
        <Link href="/" className="text-base font-semibold tracking-tight text-fg no-underline">
          actually<span className="text-muted">.</span>
        </Link>
        <nav aria-label="Principal" className="flex items-center gap-1 text-sm">
          <Link href="/" className="rounded-md px-2 py-1.5 text-muted hover:text-fg">
            Debates
          </Link>
          <Link href="/metodologia" className="rounded-md px-2 py-1.5 text-muted hover:text-fg">
            Metodologia
          </Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter({ contact }: { contact: string | null }) {
  return (
    <footer className="mt-12 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>Checagem automatizada. Pode errar — confira sempre a fonte indicada em cada alerta.</p>
        <p className="flex gap-3">
          <Link href="/metodologia" className="underline">
            Como funciona
          </Link>
          {contact ? (
            <a href={contact} className="underline">
              Reportar erro
            </a>
          ) : null}
        </p>
      </div>
    </footer>
  );
}
