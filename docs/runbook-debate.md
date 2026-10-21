# Runbook — debate de 23/10

Tudo relativo ao horário de início do debate (T). Nesta noite **não se muda código**: só configuração (thresholds, HITL, máquinas, speaker map).

Regra geral: **na dúvida, silêncio.** Nenhuma ação desta página publica alerta sem fonte; quando algo dá errado, o sistema fica quieto — e isso é aceitável.

## Quem faz o quê

| Papel | Responsabilidades | Onde |
|---|---|---|
| **Operador** | Máquinas de captura, failover, settings, monitoramento de latência/erros, decisão de parar. Fala com os serviços externos. | `/admin`, logs da Vercel, Supabase |
| **Editor principal** | Fila de aprovação (HITL), mapeamento de speakers, rejeições e notas públicas. | `/editor` |
| **Editor de apoio** | Acompanha a fila, assume em pausas, confere fontes difíceis, registra incidentes. | `/editor` (leitura), planilha de incidentes |
| **Responsável pela decisão** | Decide HITL on/off, desligar alertas, comunicação pública. Pode acumular com o operador. | — |

Todos na mesma chamada de voz durante o debate. Preencher os nomes:

| Papel | Nome | Contato |
|---|---|---|
| Operador | | |
| Editor principal | | |
| Editor de apoio | | |
| Responsável | | |

## Cronograma

### Véspera (T-24h) — preparar as máquinas e a base

**Máquinas de captura** (principal “casa” e reserva). A máquina principal pode ficar sem ninguém por perto: tudo é operado pelo `/admin`.

- [ ] Serviço instalado e rodando (`install-service --name <nome>`; ver [setup.md](setup.md#6-máquinas-de-captura)); a máquina aparece **online** no `/admin` → Máquinas de captura.
- [ ] **Energia**: na tomada (notebook: carregador conectado; desktop: de preferência com nobreak).
- [ ] **Suspensão desativada** (o serviço impede suspensão por ociosidade, mas confira: tampa do notebook fechada não pode suspender; energia → nunca suspender/hibernar na tomada).
- [ ] **Atualizações automáticas do SO adiadas** até depois do debate (Windows Update pausado; macOS “instalar atualizações automaticamente” desligado; Linux sem `unattended-upgrades` reiniciando).
- [ ] **Login automático** configurado (ou, no Linux, `loginctl enable-linger`), para o serviço voltar sozinho se a máquina reiniciar.
- [ ] Rede cabeada se possível; Wi-Fi estável como alternativa.
- [ ] `capture doctor --url <live-de-teste> --device <spec>` tudo “ok” em cada máquina (pode ser rodado remotamente por quem tiver acesso; senão, na véspera, localmente).
- [ ] **Reserva em OUTRA rede/local** (outra casa, escritório, ou internet móvel 4G/5G; uma VM de nuvem não serve para `--source device`, pois não tem áudio, e com `--source youtube` corre risco de bloqueio por IP de datacenter). Se a internet de casa cair, principal e reserva na mesma rede caem juntas.
- [ ] Teste de 10 min: iniciar as duas pelo `/admin` contra uma live qualquer, ver nível de áudio e segmentos, forçar failover (parar a principal), voltar, parar tudo.

**Base e sistema:**

- [ ] `kb-ingest status`: L1, L2 e L3 carregadas; checagens sobre o debate de 18/10 presentes; indicadores com o último dado divulgado.
- [ ] L2: migration `20261019000007_indicator_aggregation.sql` aplicada e `kb-ingest indicators` rodado **depois** dela; no `kb-ingest status`, nenhuma série `SEM AGREGAÇÃO` ou `DESATUALIZADA` (nelas a L2 fica calada ou usa aliases antigos).
- [ ] Eval rodado com a configuração final; decisão de HITL registrada em [human-in-the-loop.md](human-in-the-loop.md#registro-da-decisão).
- [ ] Debate oficial criado no `/admin` (slug, título, `scheduled_at`, URL do YouTube quando sair) **com “Debate de teste” desmarcado** — ele nasce marcado por padrão. Conferir o selo “Público” no cartão do debate.
- [ ] Ensaios: sempre como **debate de teste** (só editores veem, pela prévia `/admin/previa/<slug>`; os vereditos não valem para o oficial). Nunca tornar público um ensaio antes do dia 23.
- [ ] Settings conferidas: `t_red`, `t_yellow`, `web_penalty`, `require_red_approval`, `require_yellow_approval`, `show_attribution` (padrão `false`), `failover_after_s` (padrão 10).
- [ ] Editores com login e 2FA funcionando.
- [ ] Saldos/limites no `/admin` → **Uso das APIs**: nenhum cartão em “sem permissão”/“erro”; Tavily e Apify com folga no ciclo; banco abaixo de 70%. O que o painel não mostra, conferir no painel do provedor (link no cartão): **saldo de créditos da Anthropic**, Voyage e Deepgram da máquina de captura (se a chave não estiver na Vercel). Estimativa: o custo contado num ensaio de ~2 h × 2 (principal + margem).
- [ ] Página `/metodologia` com os thresholds e a decisão de HITL em vigor.

### T-2h

- [ ] URL da live confirmada e preenchida no debate e nas máquinas.
- [ ] **Agendar pelo /admin** → Máquinas de captura:
  - principal (“casa”): `source=youtube`, `url=<live>`, `role=primary`, `start_at = T-15min`, `stop_at = T+3h`;
  - reserva: `source=device` (loopback com a live tocando) ou `youtube` em outra rede, `role=standby`, mesmos horários.
  O daemon usa a hora do servidor, não o relógio da máquina.
- [ ] Máquinas **online** (último poll < 10 s), sem erro.
- [ ] `kb-ingest status` de novo (nada sumiu).
- [ ] `/admin` → **Uso das APIs**: mesmo conferido da véspera; na Anthropic, os limites por minuto (último retrato) com folga.
- [ ] Deploy de produção é o da `main` congelada; nenhuma mudança pendente.

### T-30min

- [ ] Editores logados no `/editor` (com 2FA), fila vazia, Realtime conectado (indicador verde).
- [ ] Operador no `/admin`: painel de latência e máquinas abertos.
- [ ] Abrir `/ao-vivo/<slug>` em uma aba anônima (modo com player e modo só informações): aviso jurídico aparece, feed conectado.
- [ ] Quando a live começar a transmitir (pré-programa), as máquinas já iniciaram (`start_at`): conferir **nível de áudio** (não pode estar em ~-90 dBFS = silêncio), segmentos chegando, **principal ativa**, reserva em standby.

### Durante

- [ ] **Mapear a Mediação SEMPRE** nas primeiras falas (`/editor` → “Quem está falando”), com `show_attribution` ligado ou não: a voz marcada como “Mediação” (mediador e jornalistas) deixa de ser checada — sem isso, pergunta de jornalista com número vira afirmação checada. Mapear os candidatos é opcional (só aparece ao público com `show_attribution`). **Remapear** após qualquer failover ou reconexão ao Deepgram: o rótulo leva a sessão do STT (`s<n>-<agente>:S<k>`) e a sessão nova chega sem mapa ([atribuicao.md](atribuicao.md)). Na dúvida sobre uma voz, deixe sem mapa.
- [ ] A cada ~10 min, o operador confere: máquina ativa, último segmento < 30 s (em fala), latência p50/p95 no `/admin`, erros; e, no **Uso das APIs**, a coluna “Esta hora” e os limites por minuto da Anthropic (restante perto de zero = alertas vão atrasar ou sumir).
- [ ] A base aprende com a web durante o debate: em `/admin` → **Base de conhecimento** → Tarefas, a carga “capturas da web” aparece sozinha e roda em segundo plano. Se ficar parada com páginas na fila, “Processar capturas da web”. Para desligar (ex.: Voyage no limite): `KB_LEARN_FROM_WEB=0` na Vercel e redeploy — a checagem ao vivo não depende disso.
- [ ] Editor segue o SLA (decisão p50 ≤ 15 s); fila > 3 → avisar o responsável.
- [ ] Registrar incidentes (horário, o que houve, o que foi feito).

### Depois

- [ ] Parar as máquinas pelo `/admin` (ou deixar o `stop_at` agir); conferir que pararam.
- [ ] Debate → status `ended`.
- [ ] Revisar pendentes: rejeitar com motivo “expirado” os que sobraram (**nunca** publicar em lote sem revisar).
- [ ] `pnpm --filter @actually/eval latency-report -- --debate <slug>` → guardar o relatório.
- [ ] Revisão pós-debate dos alertas publicados (amostra completa dos vermelhos), notas de correção se necessário.
- [ ] Reativar atualizações do SO nas máquinas.

## Subir a captura manualmente (sem o /admin)

Se o daemon/controle remoto falhar e houver alguém na máquina:

```bash
# principal
pnpm --filter @actually/capture start -- run --debate <slug> --name principal --role primary --source youtube --url <url>
# standby
pnpm --filter @actually/capture start -- run --debate <slug> --name reserva --role standby --source device --device <spec>
```

`<spec>` do dispositivo: macOS `":<índice>"`, Linux/Pulse `"<sink>.monitor"`, Windows `"audio=<nome>"` (veja `capture devices`). Não rode `run` manual **e** o daemon com `state=running` na mesma máquina: pare a máquina no `/admin` antes.

## Failover para o plano B

**Automático**: se o agente ativo fica sem heartbeat por `failover_after_s` (10 s), o banco promove o agente vivo seguinte (primary antes de standby). O standby já está transcrevendo, então a perda é de no máximo ~10 s de fala. Nada a fazer além de:

1. Confirmar no `/admin` que a reserva está **ativa** e mandando segmentos.
2. Remapear os speakers (outra sessão de diarização: rótulos novos, sem mapa).
3. Investigar a principal remotamente (abaixo).

**Manual** (`/admin` → Máquinas/agentes → **tornar ativo**): usar quando a principal está “viva” mas ruim — áudio em silêncio, transcrição lixo, atraso crescente, live do YouTube travada. Trocar e observar 1 minuto.

**Voltar para a principal**: só quando ela estiver estável por alguns minutos, e de preferência num intervalo/bloco de perguntas — também pelo “tornar ativo”.

### Se a máquina principal sair do ar (operando remotamente)

| Sintoma no /admin | Causa provável | Ação remota |
|---|---|---|
| Máquina **offline** (sem poll) e agente sem heartbeat | Máquina desligou, suspendeu, perdeu rede, reiniciou | Failover já ocorreu → confirmar reserva ativa. Se alguém puder, religar/conectar; com login automático + serviço, ela volta sozinha e entra como agente vivo (não retoma o ativo sozinha). |
| Online, `state=error`, log com erro do yt-dlp/HLS | Live caiu/mudou de URL, bloqueio | Trocar `url` no `/admin` (nova URL da live) ou trocar `source` para `device` se houver loopback. Enquanto isso, reserva ativa. |
| Online, rodando, nível de áudio ~-90 dBFS | Sem áudio (live muda, dispositivo errado) | Tornar a reserva ativa; corrigir fonte/dispositivo; voltar depois. |
| Online, `reconnects` subindo | Rede instável / Deepgram reconectando | Se os segmentos continuam chegando, observar; se lacunas > 30 s, tornar reserva ativa. |
| As duas offline | Internet comum caiu, ou falha geral | Sem captura = sem alertas (silêncio é seguro). Subir captura manual em qualquer máquina disponível com outra rede (`run ... --role primary`). Comunicar pausa se passar de alguns minutos. |

Se o **controle** (Vercel/`/api/control/poll`) cair mas a captura estiver rodando, o daemon **continua capturando** — não reiniciar nada.

## Se o Realtime cair

Nada a fazer: o site cai automaticamente para o feed `GET /api/alerts?since=` com cache de CDN (alguns segundos a mais de atraso). Conferir numa aba anônima que alertas novos continuam aparecendo. O `/editor` também depende de Realtime para a fila: recarregar a página se a fila parecer parada.

## Se a Anthropic, a Voyage ou a Tavily caírem

O pipeline fica em **silêncio** (afirmações viram log com motivo de silêncio; nenhum alerta sem verificação).

- **Não improvisar**: não publicar alertas manualmente, não trocar de modelo/fornecedor, não baixar thresholds para compensar.
- Conferir a página de status do serviço; registrar o intervalo no log de incidentes.
- Tavily fora afeta só L4 (web): L1–L3 continuam funcionando.
- Voyage fora afeta embeddings (trava de repetição, L1 e L3 vetoriais): espere bem menos alertas.
- Anthropic fora = nenhum alerta. Se passar de ~10 min, o responsável decide se publica um aviso no site (“checagem automática temporariamente indisponível”).
- Deepgram fora = sem transcrição nas duas máquinas = sem alertas; mesmo procedimento.

## Alerta errado publicado

1. Editor **retira** o alerta no `/editor` → seção **Publicados** → **Retirar**, com motivo claro (obrigatório). Para retirar a afirmação inteira, retire o **original** (sem o selo “repetição”): o banco retira junto todas as repetições dele, por qualquer caminho. Retirar só uma repetição não mexe no original nem nas outras.
   - Quem está no `/ao-vivo` vê o card trocado por “Alerta retirado após revisão” (sem a afirmação nem a correção): na hora pelo Realtime, ou em até ~30 s pela sincronização (~5 s se estiver no modo polling). Quem abre a página depois não vê nada do alerta.
   - Conferir numa aba anônima já aberta no `/ao-vivo` que o card virou o aviso.
   - `/editor` fora do ar: mesmo efeito (cascata e aviso) por SQL no painel do Supabase:
     `update alerts set status = 'rejected', reject_reason = '<motivo>', reviewed_at = now() where id = '<id do alerta>' and status = 'published';`
2. Publicar **nota pública de correção** no site (“O alerta das HH:MM sobre … foi retirado: …”).
3. **Não apagar** nada no banco: o alerta, as evidências e o histórico (`alert_events`) ficam como trilha de auditoria — as tabelas nem permitem apagar.
4. Investigar a causa (fonte? citação fora de contexto? extração?) — se for sistemática (ex.: uma série desatualizada), o responsável decide: subir `t_red`, ligar o HITL, ou desligar vermelhos. **Não corrigir código durante o debate.**
5. Se o erro for de **atribuição** (nome errado): apagar o mapeamento daquele speaker no `/editor` (todos os alertas voltam a “Afirmação feita no debate”) e publicar a nota.

## Mudanças de configuração permitidas durante o debate

| Mudança | Quando |
|---|---|
| Subir `t_red`/`t_yellow` | Alertas fracos ou erro sistemático |
| Ligar `require_red_approval`/`require_yellow_approval` | Erro publicado, ou precisão em dúvida |
| Desligar HITL | Só pelo responsável, seguindo a tabela de decisão; nunca por cansaço do editor |
| `show_attribution` | Ligar só com mapa confirmado; desligar ao primeiro erro de atribuição |
| Trocar agente ativo / fonte / URL | Problemas de captura |

Toda mudança: anunciar na chamada e registrar (horário, quem, por quê).
