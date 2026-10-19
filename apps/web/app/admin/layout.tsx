import type { Metadata } from "next";
import type { ReactNode } from "react";

// Área restrita: fora de buscadores (também via X-Robots-Tag em next.config.ts).
export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
