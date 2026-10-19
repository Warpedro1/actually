# Setup

Passo a passo para subir o ambiente do zero. Ordem: Supabase → chaves → Vercel → editores → base de conhecimento → máquinas de captura.

## 0. Pré-requisitos locais

- Node 22+ e pnpm 10 (`corepack enable`).
- `pnpm install` na raiz.
- `cp .env.example .env` e preencher conforme abaixo. **Nunca** commitar o `.env`.

## 1. Supabase

1. Criar o projeto em <https://supabase.com/dashboard> na região **South America (São Paulo) — `sa-east-1`** (mesma região da Vercel `gru1`). Plano Pro recomendado para o dia (limites de Realtime e sem pausa por inatividade).
2. Aplicar as migrations, **em ordem**:
   - `supabase/migrations/20261019000001_init.sql` — schema, trigger de evidência, append-only, RLS, RPCs, Realtime;
   - `supabase/migrations/20261019000002_remote_capture.sql` — `capture_machines` (controle remoto) e `debates.scheduled_at`;
   - `supabase/migrations/20261019000003_hardening.sql` — `search_path` fixo e revogação de RPCs sensíveis;
   - `supabase/migrations/20261019000005_mfa.sql` — `editors.mfa_required`: com a flag, `is_editor()` só vale com sessão `aal2` (2FA no banco; ver seção 4).

   Com a CLI: `supabase link --project-ref <ref>` e `supabase db push`. Sem a CLI: colar cada arquivo no SQL Editor, na ordem.
3. Conferir: Database → Extensions mostra `vector`, `pg_trgm` e `unaccent` no schema `extensions`; Advisors → Security sem alertas além dos INFO intencionais das tabelas `kb_*`/`indicator_*` (RLS sem políticas, só service role).
4. Smoke test do trigger (SQL Editor): inserir um alerta `published` sem evidência deve falhar com `não pode ser publicado sem evidência com URL e trecho verificado`.
5. Copiar de Project Settings → API para o `.env`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (**secreta**: só servidor, kb-ingest e eval)
6. Auth → URL Configuration: `Site URL` = URL de produção da Vercel; adicionar as URLs de preview em Redirect URLs.
7. Auth → Providers: e-mail habilitado; **desabilitar cadastro aberto** (“Allow new users to sign up” desligado) — editores são convidados.

## 2. Chaves de serviços

| Variável | Onde obter | Usado por |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | pipeline (Vercel), eval |
| `VOYAGE_API_KEY` | dash.voyageai.com | pipeline (embeddings/rerank), kb-ingest, eval |
| `TAVILY_API_KEY` | app.tavily.com | pipeline (L4) |
| `GOOGLE_FACTCHECK_API_KEY` | Google Cloud Console → habilitar *Fact Check Tools API* → Credenciais → chave de API (restrita a essa API) | kb-ingest (L1) |
| `DEEPGRAM_API_KEY` | console.deepgram.com | capture agent, `kb-ingest transcribe` |
| `APIFY_TOKEN` | console.apify.com → Settings → API & Integrations | kb-ingest (`apify-crawl`, `apify-youtube`, `apify-search`) |
| `INGEST_TOKEN` | gerar: `openssl rand -hex 32` | Vercel **e** máquinas de captura (mesmo valor) |

Conferir limites de taxa e saldo de cada serviço para ~2 h de debate + ensaios (Anthropic: tier com folga para Haiku contínuo; Deepgram: streaming simultâneo de 2 conexões — principal e standby).

## 3. Vercel

1. New Project → importar o repositório.
2. **Root Directory: `apps/web`**. Framework: Next.js. Install command padrão (pnpm detecta o workspace).
3. Settings → Functions → **Region: `gru1` (São Paulo)**. Fluid compute ligado.
4. Environment Variables (Production e Preview), conforme `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `TAVILY_API_KEY`
   - `INGEST_TOKEN`
   - `REQUIRE_MFA` = `1` para exigir 2FA no /editor e /admin (recomendado em produção)
   - (as chaves `GOOGLE_FACTCHECK_API_KEY`, `DEEPGRAM_API_KEY` e `APIFY_TOKEN` não são necessárias na Vercel)
5. Deploy. Plano Pro recomendado (duração de função e concorrência).
6. Conferir `GET https://<app>/api/alerts?debate=teste` responde (404/200 em JSON, não 500).

## 4. Editores (acesso ao /editor e /admin)

Só usuários presentes na tabela `editors` acessam `/editor` e `/admin`.

1. Supabase → Authentication → Users → **Invite user** (e-mail do editor). O editor define a senha pelo link.
2. Copiar o `id` (UUID) do usuário e, no SQL Editor:

   ```sql
   insert into editors (user_id, name) values ('<uuid-do-usuario>', 'Nome do Editor');
   ```

3. **2FA (TOTP)** — obrigatório quando `REQUIRE_MFA=1`:
   - Supabase → Authentication → Multi-Factor: habilitar **TOTP**.
   - No primeiro login, o /editor pede o cadastro: escanear o QR code com um app autenticador (Google Authenticator, 1Password, Authy…) e digitar o código de 6 dígitos.
   - A partir daí, cada login pede o código (sessão `aal2`).
   - **Depois que o editor cadastrar o TOTP, marque a exigência no banco.** `REQUIRE_MFA` só protege a interface; sem
     a flag, quem tiver só a senha ainda age como editor chamando a API do Supabase direto. Com `mfa_required = true`,
     `is_editor()` (RLS e `capture_set_active`) só vale com sessão `aal2`:

     ```sql
     update editors set mfa_required = true where user_id = '<uuid-do-usuario>';
     -- ou todos os editores que já têm TOTP verificado:
     update editors set mfa_required = true
     where user_id in (select user_id from auth.mfa_factors where factor_type = 'totp' and status = 'verified');
     -- conferir (em produção, todos true):
     select name, mfa_required from editors;
     ```

     Se marcar antes do cadastro, nada tranca: o /editor leva a conta ao cadastro do autenticador, e o banco não libera
     nenhuma ação de editor até lá.
   - Perdeu o celular? Um admin remove o fator em Authentication → Users → (usuário) → MFA factors, e o editor cadastra de novo (com `mfa_required = true`, a conta fica sem permissão de editor até cadastrar).
4. Remover acesso: `delete from editors where user_id = '<uuid>';` (e desativar o usuário no Auth).

## 5. Base de conhecimento

Ver [fontes.md](fontes.md). Com o `.env` preenchido (service role, Voyage, Google Fact Check, Deepgram, Apify):

```bash
pnpm --filter @actually/kb-ingest start -- tiers         # sincroniza SOURCE_TIERS → source_tiers
pnpm --filter @actually/kb-ingest start -- indicators    # L2
pnpm --filter @actually/kb-ingest start -- factchecks    # L1 (Google Fact Check + agências)
pnpm --filter @actually/kb-ingest start -- apify-crawl   # L1 sem RSS e sites de campanha (L3)
pnpm --filter @actually/kb-ingest start -- apify-youtube # entrevistas e debates (L3)
pnpm --filter @actually/kb-ingest start -- documents     # L3 (programas, Senado, legislação)
pnpm --filter @actually/kb-ingest start -- status        # contagens por camada
```

Os nomes exatos de comandos e flags estão no `--help` do `kb-ingest`.

## 6. Máquinas de captura

Em **cada** máquina (principal e reserva):

1. Instalar Node 22+, pnpm, **ffmpeg** e **yt-dlp** (macOS: `brew install ffmpeg yt-dlp`; Windows: `winget install ffmpeg yt-dlp`; Linux: pacote da distro + `pipx install yt-dlp`).
2. Clonar o repositório e `pnpm install`.
3. Criar `~/.actually/capture.env` (lido pelo daemon e pelo CLI; permissão só do usuário: `chmod 600`):

   ```bash
   DEEPGRAM_API_KEY=...
   INGEST_TOKEN=...            # o mesmo da Vercel
   ACTUALLY_API_URL=https://<app>.vercel.app
   ```

4. Diagnóstico: `pnpm --filter @actually/capture start -- doctor --url <live-de-teste> --device <spec>` — tudo “ok”. `... start -- devices` lista os dispositivos de áudio.
   - Loopback (plano B por dispositivo): macOS precisa de BlackHole (ou similar) com a saída roteada; Windows, “Mixagem estéreo” ou VB-CABLE; Linux/Pulse, `<sink>.monitor`.
5. **Instalar o serviço** (sobe no boot, reinicia se cair, impede suspensão enquanto roda):

   ```bash
   pnpm --filter @actually/capture start -- install-service --name casa     # na principal
   pnpm --filter @actually/capture start -- install-service --name reserva  # na reserva
   ```

   `--print` mostra o que seria instalado sem instalar. Por SO: macOS usa launchd (com `caffeinate`), Linux usa systemd de usuário (rodar `sudo loginctl enable-linger $USER` para subir sem login), Windows usa o Agendador de Tarefas (ajustar energia com `powercfg`, como o comando indica). Remover: `uninstall-service`.
6. No `/admin` → **Máquinas de captura**, a máquina aparece pelo nome em poucos segundos (online). Fazer um teste: iniciar com `source=file` ou uma live qualquer, ver nível de áudio e segmentos chegando, parar.

## 7. Verificação final

```bash
pnpm typecheck
pnpm test
pnpm eval -- --data eval/data/smoke.jsonl     # encanamento do pipeline com chaves reais
```

E seguir o [runbook](runbook-debate.md) para o ensaio.
