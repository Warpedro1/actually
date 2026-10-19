import { describe, expect, it } from "vitest";
import { desiredSourceError, youtubeCaptureUrlError } from "@/lib/captureSource";

describe("[RNF05] [RF13] fonte da captura remota (URL do /admin)", () => {
  it("aceita links http(s) do YouTube", () => {
    for (const ok of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/live/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/@canal/live",
    ]) {
      expect(youtubeCaptureUrlError(ok), ok).toBeNull();
    }
  });

  it("recusa opção disfarçada de URL, outros hosts e esquemas", () => {
    for (const bad of [
      "--update-to=atacante/repo@v1",
      "--config-locations=\\\\host\\share",
      "-o",
      " https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ --exec x",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com@evil.com/watch",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "file:///etc/passwd",
      "youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(youtubeCaptureUrlError(bad), bad).not.toBeNull();
    }
  });

  it("valida por fonte: youtube pela regra acima, arquivo sem “-” inicial, dispositivo ignora url", () => {
    expect(desiredSourceError({ source: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" })).toBeNull();
    expect(desiredSourceError({ source: "youtube", url: "--update-to=a/b@v1" })).toMatch(/recusada/);
    expect(desiredSourceError({ source: "file", url: "/videos/debate.mp4" })).toBeNull();
    expect(desiredSourceError({ source: "file", url: "-i" })).not.toBeNull();
    expect(desiredSourceError({ source: "device" })).toBeNull();
    expect(desiredSourceError({ source: "youtube" })).toBeNull(); // ausência é checada à parte
  });
});

describe("[RNF05] fonte remota no /admin: URL e arquivo seguros", () => {
  it("[RNF05] recusa '\\' e host escondido antes de '@'; aceita @canal no caminho", () => {
    expect(youtubeCaptureUrlError("http://youtube.com\\@127.0.0.1:8765/x")).not.toBeNull();
    expect(youtubeCaptureUrlError("https://youtube.com@evil.com/watch?v=x")).not.toBeNull();
    expect(youtubeCaptureUrlError("https://www.youtube.com/@canal/live")).toBeNull();
  });
  it("[RNF05] arquivo: nada de URL, caminho de rede ou '..'", () => {
    for (const url of ["http://10.0.0.1/x.mp4", "tcp://h:1", "\\\\host\\share\\x.mp4", "//host/share/x", "../x.wav"]) {
      expect(desiredSourceError({ source: "file", url }), url).not.toBeNull();
    }
    expect(desiredSourceError({ source: "file", url: "ontem.mp4" })).toBeNull();
  });
});
