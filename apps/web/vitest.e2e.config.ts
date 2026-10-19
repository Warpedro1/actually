import { defineConfig } from "vitest/config";

// Testes de navegador contra o build de produção (pnpm build antes).
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
