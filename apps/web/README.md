# @actually/web

Site e API na Vercel (Next.js 16, App Router): `/ao-vivo/[slug]` (feed de alertas em tempo real), `/metodologia`,
`/editor` (fila de revisão HITL + mapeamento de vozes), `/admin` (máquinas de captura, debate, configurações,
latência, neutralidade) e as rotas do capture agent.

| Rota | O que faz |
|---|---|
| `POST /api/ingest/register` · `heartbeat` · `segment` | Capture agent (header `x-ingest-token`). O segmento é gravado e o pipeline roda em `after()` |
| `POST /api/control/poll` | Daemon de captura: reporta estado e recebe o desejado definido no /admin |
| `GET /api/alerts?debate=<slug>&since=<iso>` | Fallback do Realtime, cache de CDN `s-maxage=2` |
| `GET /api/health` | `{ok:true}` para o `capture doctor` |

Modo demonstração, sem Supabase: `/ao-vivo/demo` (simulador injeta alertas) e `/admin/demo` (painel de máquinas).

## Variáveis

Veja `.env.example`. Resumo: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
(só servidor), `INGEST_TOKEN`, `NEXT_PUBLIC_CONTACT` (e-mail/URL para reportar erro), `REQUIRE_MFA=1` (opcional) e as
chaves do pipeline (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `TAVILY_API_KEY`). As `NEXT_PUBLIC_*` entram no bundle
no build: mudou, faça redeploy. Sem variáveis o build passa e as páginas mostram o erro em runtime.

## Desenvolvimento

```bash
pnpm install                       # na raiz do monorepo
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @actually/web dev    # http://localhost:3000/ao-vivo/demo
pnpm --filter @actually/web typecheck && pnpm --filter @actually/web test && pnpm --filter @actually/web build
```

Screenshots do modo demo (usa o Chromium já instalado, não baixa navegador):
`pnpm --filter @actually/web start` e, em outro terminal,
`BASE_URL=http://localhost:3000 OUT_DIR=/tmp/shots pnpm --filter @actually/web screenshots`.

## Deploy na Vercel

1. Importe o repositório; **Root Directory = `apps/web`** (deixe "Include files outside the root directory" ligado —
   os pacotes `@actually/db` e `@actually/pipeline` vivem em `packages/`). A Vercel detecta o pnpm workspace e instala
   a partir da raiz.
2. Região das funções: `gru1` (São Paulo), já fixada em `vercel.json`. O Supabase fica em **`sa-east-1`** (São Paulo):
   função e banco na mesma região mantêm a latência de cada consulta em ~1–2 ms.
3. Configure as variáveis acima (Production e Preview). Plano Pro recomendado (`maxDuration` 60 s no segmento).
4. No Supabase: Authentication → URL Configuration → adicione o domínio do site em *Redirect URLs* (link mágico).
   Desative cadastro aberto (Authentication → Providers → Email → *Allow new users to sign up* desligado); o login
   usa `shouldCreateUser: false`.

## Criar um editor

1. Supabase → Authentication → Users → *Add user* (e-mail + senha, ou convite).
2. SQL Editor:
   ```sql
   insert into editors (user_id, name)
   select id, 'Nome do editor' from auth.users where email = 'editor@exemplo.com';
   ```
3. Entre em `/editor`. Sem a linha em `editors`, a conta entra mas vê "Sem acesso de editor" — e a RLS não libera nada.

## 2FA (TOTP)

- Qualquer editor pode cadastrar um app autenticador em **`/editor/seguranca`** (Google Authenticator, 1Password…).
  Com fator cadastrado, o código passa a ser pedido em todo login.
- Com `REQUIRE_MFA=1`, `/editor` e `/admin` exigem sessão `aal2`: quem não tem fator é levado ao cadastro antes de
  entrar. Habilite MFA TOTP no Supabase (Authentication → Multi-Factor, ligado por padrão).
- A checagem de `aal2` hoje é na interface. Para valer também no banco, `is_editor()` precisa conferir
  `auth.jwt() ->> 'aal' = 'aal2'` (mudança de migration, fora deste app).
- `/editor` e `/admin` têm `noindex` (meta + `X-Robots-Tag`) e estão fora do `robots.txt`.

## Tempo real e carga

O feed assina `postgres_changes` em `alerts` (filtrado por `debate_id`) e busca as evidências do alerta com a anon
key (com jitter de até 0,8 s para espalhar a carga). Se o canal cair, expirar ou não conectar em 8 s, passa a fazer
polling em `/api/alerts` a cada 3 s com cursor arredondado ao segundo (milhares de clientes no mesmo cursor = um acerto
de CDN) e tenta reassinar a cada 15 s. Mesmo com Realtime ok, sincroniza a cada 30 s. Deduplicação por id.
