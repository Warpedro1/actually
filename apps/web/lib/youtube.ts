// Extrai o ID do vídeo de qualquer formato comum de URL do YouTube e monta o
// embed no domínio youtube-nocookie (sem cookies de rastreamento até o play).

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (ID_RE.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const [, kind, value] = u.pathname.split("/");
      if (kind && ["embed", "live", "shorts", "v"].includes(kind)) id = value ?? null;
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

export function youtubeEmbedUrl(url: string | null | undefined): string | null {
  const id = youtubeVideoId(url);
  if (!id) return null;
  const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}
