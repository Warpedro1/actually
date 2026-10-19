import { youtubeEmbedUrl } from "@/lib/youtube";

/** Player da transmissão (youtube-nocookie). Sem URL válida, mostra um aviso no lugar. */
export function VideoPlayer({ url, title }: { url: string | null; title: string }) {
  const embed = youtubeEmbedUrl(url);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
      {embed ? (
        <iframe
          src={embed}
          title={`Transmissão: ${title}`}
          className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-neutral-300">
          <span aria-hidden="true" className="text-3xl">
            ▶
          </span>
          <p className="text-sm">Transmissão ainda não disponível aqui.</p>
          <p className="text-xs text-neutral-400">Os alertas continuam chegando normalmente.</p>
        </div>
      )}
    </div>
  );
}
