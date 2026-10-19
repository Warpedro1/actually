// Validação da fonte no estado desejado das máquinas de captura (/admin e
// /api/control/poll). A URL vai parar no argv do yt-dlp/ffmpeg na máquina de
// captura: só http(s) do YouTube, nunca algo que comece com "-" (viraria opção,
// ex.: "--update-to=..."). Mesma regra de youtubeUrlError em
// apps/capture/src/audio.ts — o daemon checa de novo antes de qualquer spawn.

import type { MachineDesired } from "@actually/db";

const YOUTUBE_HOST_RE = /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/;

/** Por que a URL não serve como fonte da captura (null = serve). */
export function youtubeCaptureUrlError(url: string): string | null {
  if (url.startsWith("-")) return "não pode começar com “-”";
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return "não pode ter espaços nem caracteres de controle";
  if (!/^https?:\/\//i.test(url)) return "precisa começar com https://";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "URL inválida";
  }
  if (u.username || u.password || u.port) return "não pode ter usuário, senha ou porta";
  if (!YOUTUBE_HOST_RE.test(u.hostname)) return `precisa ser do YouTube (youtube.com ou youtu.be), não ${u.hostname}`;
  return null;
}

/** Erro da fonte do desejado, pronto para mostrar (null = ok ou sem URL). */
export function desiredSourceError(d: Pick<MachineDesired, "source" | "url">): string | null {
  if (d.url === undefined) return null;
  if (d.source === "youtube") {
    const err = youtubeCaptureUrlError(d.url);
    return err ? `URL da live recusada: ${err}.` : null;
  }
  if (d.source === "file") {
    if (d.url.startsWith("-")) return "Caminho do arquivo não pode começar com “-”.";
    if (/[\u0000-\u001f\u007f]/.test(d.url)) return "Caminho do arquivo com caractere de controle.";
  }
  return null;
}
