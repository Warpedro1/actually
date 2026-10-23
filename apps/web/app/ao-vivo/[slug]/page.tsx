import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveDebate } from "@/components/live/LiveDebate";
import { Notice } from "@/components/Notice";
import { SUPABASE_MISSING_MESSAGE } from "@/lib/env";
import { loadDebate } from "@/lib/server/debates";

// Casca da página cacheada (ISR) — os alertas chegam no cliente via Realtime/API.
export const revalidate = 15;

type Props = { params: Promise<{ slug: string }> };

// Nenhum debate pré-renderizado no build (não há banco no build); cada slug é
// gerado no primeiro acesso e cacheado por `revalidate` segundos.
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const res = await loadDebate(slug);
  return { title: res.ok && res.data ? res.data.debate.title : "Ao vivo" };
}

export default async function LivePage({ params }: Props) {
  const { slug } = await params;
  const res = await loadDebate(slug);
  if (!res.ok) {
    return (
      <Notice title="Checagem ao vivo indisponível" tone="warn">
        <p>{res.reason === "unconfigured" ? SUPABASE_MISSING_MESSAGE : `Erro ao carregar o debate: ${res.message}`}</p>
        <p className="mt-2">
          Veja como funciona na <Link href="/ao-vivo/demo" className="underline">demonstração</Link>.
        </p>
      </Notice>
    );
  }
  if (!res.data) notFound();
  const { debate, attribution } = res.data;
  return (
    <LiveDebate
      debate={{
        id: debate.id,
        slug: debate.slug,
        title: debate.title,
        status: debate.status,
        check_mode: debate.check_mode,
        public_note: debate.public_note,
        youtube_url: debate.youtube_url,
      }}
      attribution={attribution}
    />
  );
}
