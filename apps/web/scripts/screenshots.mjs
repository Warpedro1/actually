// Screenshots do modo demonstração (desktop e celular 390 px).
// Uso: com o app rodando (pnpm build && pnpm start), execute
//   BASE_URL=http://localhost:3000 OUT_DIR=/tmp/shots node scripts/screenshots.mjs
// Usa o Chromium já instalado (PLAYWRIGHT_BROWSERS_PATH ou CHROMIUM_PATH); não baixa navegador.
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.OUT_DIR ?? "screenshots";
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  if (!dir) throw new Error(`Chromium não encontrado em ${root}`);
  return join(root, dir, "chrome-linux", "chrome");
}

const VIEWPORTS = {
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const browser = await chromium.launch({ executablePath: findChromium() });
const shots = [];

async function page(vp, { scheme = "light", accepted = true, viewMode = "video" } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], colorScheme: scheme, ...VIEWPORTS[vp] });
  await ctx.addInitScript(
    ([accepted, viewMode]) => {
      try {
        if (accepted) localStorage.setItem("actually:disclaimer", "v1");
        else localStorage.removeItem("actually:disclaimer");
        localStorage.setItem("actually:view-mode", viewMode);
      } catch {}
    },
    [accepted, viewMode],
  );
  return { ctx, p: await ctx.newPage() };
}

async function shot(name, vp, url, opts = {}, after) {
  const { ctx, p } = await page(vp, opts);
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await p.goto(BASE + url, { waitUntil: "networkidle" });
  if (after) await after(p);
  const file = join(OUT, `${name}.png`);
  await p.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  shots.push(file);
  if (errors.length) console.warn(`[${name}] erros no console:`, errors);
  await ctx.close();
}

// Deixa o simulador injetar ao menos um alerta novo (animação de entrada).
const waitAlert = (p) => p.waitForTimeout(6800);

for (const vp of ["desktop", "mobile"]) {
  await shot(`${vp}-aviso`, vp, "/ao-vivo/demo", { accepted: false });
  await shot(`${vp}-com-video`, vp, "/ao-vivo/demo", { viewMode: "video" }, waitAlert);
  await shot(`${vp}-so-informacoes`, vp, "/ao-vivo/demo", { viewMode: "info" }, waitAlert);
  await shot(`${vp}-escuro`, vp, "/ao-vivo/demo", { viewMode: "info", scheme: "dark" }, waitAlert);
  await shot(`${vp}-maquinas`, vp, "/admin/demo", { fullPage: true });
  await shot(`${vp}-maquinas-comando`, vp, "/admin/demo", { fullPage: true }, async (p) => {
    await p.locator("summary", { hasText: "Comandar esta máquina" }).first().click();
  });
}
await shot("mobile-metodologia", "mobile", "/metodologia");
await shot("desktop-inicio", "desktop", "/");

await browser.close();
console.log(shots.join("\n"));
