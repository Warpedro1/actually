import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/SiteHeader";
import { BOOT_SCRIPT } from "@/lib/disclaimer";
import { contactHref } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "actually — checagem ao vivo do debate", template: "%s · actually" },
  description:
    "Checagem de fatos automatizada e ao vivo do debate presidencial de 2026. Cada alerta traz a fonte. Pode errar: confira sempre.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f4" },
    { media: "(prefers-color-scheme: dark)", color: "#111213" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#conteudo"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
        >
          Pular para o conteúdo
        </a>
        <SiteHeader />
        <main id="conteudo">{children}</main>
        <SiteFooter contact={contactHref()} />
      </body>
    </html>
  );
}
