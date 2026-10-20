import type { Metadata } from "next";
import { PreviewShell } from "@/components/staff/Shells";
import { requireMfa } from "@/lib/server/staff";

// Lê REQUIRE_MFA em runtime; o conteúdo vem do navegador com a sessão do editor.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Prévia do debate" };

type Props = { params: Promise<{ slug: string }> };

/** /ao-vivo como o público vê, para editores — inclusive debate de teste. */
export default async function PreviewPage({ params }: Props) {
  const { slug } = await params;
  return <PreviewShell requireMfa={requireMfa()} slug={slug} />;
}
