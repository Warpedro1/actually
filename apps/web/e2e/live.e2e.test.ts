// Testes de ponta a ponta no navegador (Chromium) contra o build de produção,
// no modo demonstração (não depende de Supabase). Rode com `pnpm test:e2e`
// depois de `pnpm build`.
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE = `http://localhost:${PORT}`;
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  if (!dir) throw new Error(`Chromium não encontrado em ${root}`);
  for (const sub of ["chrome-linux", "chrome-linux64"]) {
    const p = join(root, dir, sub, "chrome");
    try {
      readdirSync(join(root, dir, sub));
      return p;
    } catch {
      // tenta o próximo layout
    }
  }
  throw new Error(`binário do Chromium não encontrado em ${join(root, dir)}`);
}

let server: ChildProcess;
let browser: Browser;

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start não respondeu");
}

beforeAll(async () => {
  server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "ignore",
  });
  await waitForServer();
  browser = await chromium.launch({ executablePath: findChromium() });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
});

async function open(path: string, opts: { accepted?: boolean; mobile?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(opts.mobile ? MOBILE : { viewport: { width: 1366, height: 900 } });
  // O iframe do YouTube não importa aqui e não deve depender de rede externa.
  await ctx.route(/youtube(-nocookie)?\.com/, (r) => r.abort());
  if (opts.accepted) {
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("actually:disclaimer", "v1");
      } catch {
        // sem storage
      }
    });
  }
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  return { ctx, page };
}

describe("[RF10] aviso jurídico bloqueante", () => {
  it("[RF10] primeira visita: modal com o aviso bloqueia a página até o aceite, que é lembrado", async () => {
    const { ctx, page } = await open("/ao-vivo/demo");
    const dialog = page.getByRole("dialog");
    await expect(dialog.isVisible()).resolves.toBe(true);
    expect(await dialog.textContent()).toContain("Pode errar");
    expect(await dialog.textContent()).toContain("verifique a fonte");
    // conteúdo atrás do modal fica inerte (não clicável nem focável)
    expect(await page.locator("[inert]").count()).toBeGreaterThan(0);

    await dialog.getByRole("button").first().click();
    await expect(page.getByRole("dialog").count()).resolves.toBe(0);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("dialog").isVisible()).resolves.toBe(false);
    await ctx.close();
  });

  it("[RF10] aviso continua visível como banner depois do aceite", async () => {
    const { ctx, page } = await open("/ao-vivo/demo", { accepted: true });
    expect(await page.textContent("body")).toMatch(/pode errar/i);
    await ctx.close();
  });
});

describe("[RF11] com vídeo / só informações", () => {
  it("[RF11] alterna entre player e só feed, e lembra a escolha", async () => {
    const { ctx, page } = await open("/ao-vivo/demo", { accepted: true });
    // área do player: iframe da live ou aviso "Transmissão ainda não disponível" (o demo não tem URL)
    const player = page.locator(".aspect-video");
    expect(await player.count()).toBe(1);

    await page.getByRole("button", { name: "Só informações" }).click();
    expect(await player.count()).toBe(0);
    expect(await page.locator("article").count()).toBeGreaterThan(0);

    await page.reload({ waitUntil: "networkidle" });
    expect(await page.locator(".aspect-video").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Só informações" }).getAttribute("aria-pressed")).toBe("true");

    await page.getByRole("button", { name: "Com vídeo" }).click();
    expect(await page.locator(".aspect-video").count()).toBe(1);
    await ctx.close();
  });
});

describe("[RF05] [RF04] alerta na interface", () => {
  it("[RF05] [RF04] todo alerta mostra selo em texto, correção e fonte com link http(s) e trecho", async () => {
    const { ctx, page } = await open("/ao-vivo/demo", { accepted: true });
    const cards = page.locator("article");
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      expect(await card.textContent()).toMatch(/Contradito pelas fontes|Impreciso/);
      const hrefs = await card.locator("figure a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h).toMatch(/^https?:\/\//);
      expect(await card.locator("blockquote").count()).toBeGreaterThan(0);
    }
    await ctx.close();
  });
});

describe("[RF15] painel da base no /admin: confirmação antes de criar tarefa", () => {
  it("[RF15] clique abre a confirmação no lugar; Cancelar não pede nada; Confirmar pede", async () => {
    const { ctx, page } = await open("/admin/demo");
    await page.getByRole("tab", { name: "Base de conhecimento" }).click();
    const base = page.locator("#base");
    await base.waitFor();
    const status = base.locator('[role="status"]');
    const confirmBox = base.getByRole("group", { name: "Confirmar tarefa" });

    await base.getByRole("button", { name: "Atualização diária", exact: true }).click();
    expect(await confirmBox.count()).toBe(1);
    expect(await confirmBox.textContent()).toMatch(/atualização diária/i);
    // foco vai para o botão de confirmar (teclado: Enter confirma, Esc cancela)
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Confirmar");
    expect(await status.count()).toBe(0);

    await confirmBox.getByRole("button", { name: "Cancelar" }).click();
    expect(await confirmBox.count()).toBe(0);
    expect(await status.count()).toBe(0);

    await base.getByRole("button", { name: "Atualização diária", exact: true }).click();
    await page.keyboard.press("Escape");
    expect(await confirmBox.count()).toBe(0);

    await base.getByRole("button", { name: "Atualização diária", exact: true }).click();
    await confirmBox.getByRole("button", { name: "Confirmar" }).click();
    expect(await status.textContent()).toMatch(/atualizacao-diaria/);
    await ctx.close();
  });

  it("[RF15] ações agrupadas por categoria", async () => {
    const { ctx, page } = await open("/admin/demo#base");
    const base = page.locator("#base");
    await base.waitFor();
    const groups = await base.locator("section h3").allTextContents();
    expect(groups).toEqual(
      expect.arrayContaining(["Carga inicial", "Manutenção", "Checagens já publicadas (L1)", "Indicadores oficiais (L2)", "Documentos e registros (L3)"]),
    );
    await ctx.close();
  });
});

describe("[RNF05] painel de uso das APIs no /admin", () => {
  it("[RNF05] um cartão por provedor, com situação, barra de limite acessível e link do provedor", async () => {
    const { ctx, page } = await open("/admin/demo", { mobile: true });
    await page.getByRole("tab", { name: "Uso das APIs" }).click();
    const uso = page.locator("#uso");
    await uso.waitFor();
    const cards = uso.locator("article");
    expect(await cards.count()).toBe(8);
    const tavily = uso.getByRole("article", { name: "Tavily (busca web)" });
    const bar = tavily.getByRole("progressbar", { name: /Créditos do plano/ });
    expect(await bar.getAttribute("aria-valuenow")).toBe("81");
    expect(await tavily.textContent()).toMatch(/Contado pelo actually/);
    const apify = uso.getByRole("article", { name: "Apify (robôs)" });
    expect(await apify.textContent()).toMatch(/sem chave/);
    for (const href of await uso.locator("article a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) {
      expect(href).toMatch(/^https:\/\//);
    }
    await ctx.close();
  });
});

describe("[RNF10] abas do /admin", () => {
  it("[RNF10] teclado troca de aba e move o foco, só o painel ativo fica na página e o # da URL abre a aba", async () => {
    const { ctx, page } = await open("/admin/demo");
    await page.getByRole("tablist", { name: "Seções do admin" }).waitFor();
    expect(await page.getByRole("tab").allTextContents()).toEqual(["Ao vivo", "Base de conhecimento", "Uso das APIs"]);
    const aoVivo = page.getByRole("tab", { name: "Ao vivo" });
    expect(await aoVivo.getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#maquinas").count()).toBe(1);
    expect(await page.locator("#base").count()).toBe(0);

    await aoVivo.focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.getByRole("tab", { name: "Base de conhecimento" }).getAttribute("aria-selected")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Base de conhecimento");
    await page.locator("#base").waitFor();
    expect(await page.locator("#maquinas").count()).toBe(0);
    expect(new URL(page.url()).hash).toBe("#base");

    await page.keyboard.press("End");
    expect(await page.getByRole("tab", { name: "Uso das APIs" }).getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("ArrowRight");
    expect(await aoVivo.getAttribute("aria-selected")).toBe("true");
    await ctx.close();

    const direct = await open("/admin/demo#uso");
    await direct.page.locator("#uso").waitFor();
    expect(await direct.page.getByRole("tab", { name: "Uso das APIs" }).getAttribute("aria-selected")).toBe("true");
    await direct.ctx.close();
  });
});

describe("[RNF10] celular e acessibilidade", () => {
  for (const path of ["/ao-vivo/demo", "/metodologia", "/", "/admin/demo"]) {
    it(`[RNF10] ${path} em 390 px sem rolagem horizontal`, async () => {
      const { ctx, page } = await open(path, { accepted: true, mobile: true });
      const { scroll, width } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(width);
      await ctx.close();
    });
  }

  it("[RNF10] modal do aviso é acessível: role=dialog, aria-modal e foco no botão", async () => {
    const { ctx, page } = await open("/ao-vivo/demo", { mobile: true });
    const dialog = page.getByRole("dialog");
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    const focusedInDialog = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    expect(focusedInDialog).toBe(true);
    await ctx.close();
  });

  it("[RNF10] página declara idioma pt-BR", async () => {
    const { ctx, page } = await open("/ao-vivo/demo", { accepted: true });
    expect(await page.getAttribute("html", "lang")).toBe("pt-BR");
    await ctx.close();
  });
});
