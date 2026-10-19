# @actually/capture

CLI que captura o áudio do debate, transcreve em streaming (Deepgram, pt-BR, com diarização) e envia os trechos finais para a API (`/api/ingest/*`). Roda em macOS, Linux e Windows.

```
fonte (youtube | device | file) → ffmpeg → PCM 16 kHz mono → Deepgram WS → segmentador → fila → POST /api/ingest/segment
```

## Instalação

- **Node 22+** e **pnpm** (`pnpm install` na raiz do repo).
- **ffmpeg** no PATH — macOS: `brew install ffmpeg`; Linux: `sudo apt install ffmpeg`; Windows: `winget install Gyan.FFmpeg`.
- **yt-dlp** no PATH (só para `--source youtube`) — `brew install yt-dlp`, `pipx install yt-dlp` ou `winget install yt-dlp`. Atualize no dia (`yt-dlp -U`): o YouTube muda com frequência.
- Caminhos fora do PATH: `FFMPEG_PATH` e `YTDLP_PATH`.

## Variáveis

| Variável | Para quê |
|---|---|
| `DEEPGRAM_API_KEY` | STT |
| `INGEST_TOKEN` | header `x-ingest-token` da API |
| `ACTUALLY_API_URL` | URL da API (ou `--api`) |

São lidas do ambiente, do `.env` do diretório atual, do `.env` da raiz do repo e de `~/.actually/capture.env`, nessa ordem, sem sobrescrever o que já existe.

## Comandos

Da raiz: `pnpm --filter @actually/capture start -- <comando>` (abaixo, `capture` = isso). Os logs vão para `apps/capture/capture-logs/` por padrão.

```bash
capture doctor --url "https://www.youtube.com/watch?v=LIVE" --device ":0"   # checa tudo antes
capture devices                                                            # lista dispositivos de áudio

# Plano A — principal, direto da live do YouTube
capture run --debate debate-23-10 --name mac-pedro --role primary \
  --source youtube --url "https://www.youtube.com/watch?v=LIVE"

# Plano B — hot standby, capturando o áudio do sistema enquanto a live toca
capture run --debate debate-23-10 --name note-standby --role standby --source device --device ":1"           # macOS (BlackHole)
capture run --debate debate-23-10 --name nuc --role standby --source device \
  --device "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor"                                            # Linux (monitor do sink)
capture run --debate debate-23-10 --name pc --role standby --source device --device "audio=CABLE Output (VB-Audio Virtual Cable)"  # Windows

# Replay (ensaio geral com o debate de ontem), em tempo real
capture run --debate ensaio-22-10 --name replay --source file --file ~/debate-ontem.mp4
# ...ou o mais rápido possível, só para testar transcrição sem backend
capture run --debate ensaio --name teste --source file --file ~/debate-ontem.mp4 --no-realtime --dry-run
```

Opções comuns: `--api <url>`, `--stt-model` (padrão `nova-3`; se o modelo recusar pt-BR — HTTP 400 no handshake — cai sozinho para `--stt-fallback-model`, padrão `nova-2`), `--dry-run` (não chama a API, só imprime segmentos), `--log-dir`, `--ytdlp-format` (padrão `bestaudio/best`; numa conexão fraca, `bestaudio/best[height<=360]`).

**Áudio do sistema (loopback):** macOS precisa de um dispositivo virtual (BlackHole) com a saída roteada para ele; Linux usa o `.monitor` do sink (`capture devices` mostra o do sink padrão); Windows usa "Mixagem estéreo" ou VB-CABLE.

## Como funciona

- **Principal × standby:** os dois registram, mandam heartbeat a cada 2 s e enviam segmentos. A API só aceita os do agente **ativo**; o outro recebe `standby` (normal, continua transcrevendo). Sem heartbeat do ativo por 10 s, o standby assume. A linha de status mostra `[ATIVO]`/`[STANDBY]`.
- **Segmentos:** emitidos no `speech_final`/`UtteranceEnd` do Deepgram, na troca estável de speaker (≥ 3 palavras) ou a cada ~25 s de fala contínua (de preferência em fim de frase). `t_start`/`t_end` são segundos desde o início da captura e nunca voltam (quedas da fonte viram silêncio).
- **Resiliência:** fonte ao vivo que cai é reiniciada com backoff; processo que não manda nenhum byte em 60 s e dispositivo que trava (20 s sem bytes) também. Live do YouTube que mandou áudio e parou (playlist sem fim) **não** é morta pelo watchdog: o processo novo repetiria os últimos ~12 s já enviados (viraria “Repetido” falso); ela fica muda até voltar ou o operador agir (runbook: tornar a reserva ativa, trocar a URL). Limitação conhecida: se o próprio yt-dlp desistir e sair, o reinício normal ainda repete esse trecho. WS do Deepgram que cai — ou que não responde ping por 15 s, ou não manda nenhuma mensagem por 60 s, com áudio fluindo — reconecta e reenvia o áudio ainda não finalizado (até 120 s em buffer); cada reconexão abre sessão nova de diarização (rótulos novos, sem mapa: ver [atribuição](../../docs/atribuicao.md)). Envio com retry exponencial, em ordem, idempotente por `seq`. Ctrl+C encerra limpo (fecha o stream, drena a fila); Ctrl+C de novo força.
- **Log JSONL** (`<log-dir>/<debate>-<nome>-<timestamp>.jsonl`): finais do Deepgram com palavras, segmentos, respostas da API, quedas/reconexões — serve de auditoria e para reprocessar.
- Para ensaios locais, `DEEPGRAM_WS_URL` aponta o STT para outro endpoint.

## Rodando sem ninguém perto da máquina

Em vez de `run`, a máquina roda o **daemon** como serviço do sistema. Ele consulta `POST /api/control/poll` a cada 3 s, reporta o estado (nível de áudio, segmentos, erros, últimas linhas de log) e obedece ao que estiver definido no **/admin**: iniciar, parar, agendar (`start_at`/`stop_at`, pelo relógio do servidor), trocar fonte/URL/dispositivo/papel. Todo o controle é pelo /admin.

- Se o runner falhar, o daemon reporta `error` e tenta de novo com backoff.
- Se a API de controle ficar inacessível, **mantém o que está fazendo** (não para a captura por falta de rede de controle). O último estado desejado fica em `~/.actually/daemon-state.json` e sobrevive a um reboot.
- Replay de arquivo que terminou não recomeça sozinho; mude o desejado no /admin.

### Instalar

```bash
capture install-service --name mac-sala --api https://<app>.vercel.app   # --print mostra o que seria feito
# preencha ~/.actually/capture.env (criado com permissão 600) e reinicie o serviço
capture uninstall-service
```

| SO | O que é instalado | Logs |
|---|---|---|
| macOS | LaunchAgent `ai.actually.capture` (RunAtLoad, KeepAlive), envolto em `caffeinate -is` | `~/.actually/logs/daemon.out.log` |
| Linux | unit `systemd --user` `actually-capture.service` (Restart=always) | `journalctl --user -u actually-capture -f` |
| Windows | Tarefa Agendada `actually-capture` (no logon, reinicia em falha, `--supervise`) | `~/.actually/logs/daemon-<nome>.log` |

O daemon também grava `daemon-<nome>.log` e um JSONL por captura em `~/.actually/logs/`.

### Checklist da máquina (faça com alguém presente, dias antes)

- [ ] `capture doctor --url <live> --device <spec>` passando, com o mesmo usuário do serviço.
- [ ] **Energia/suspensão:** macOS — nunca dormir na tomada (o `caffeinate` cobre enquanto o daemon roda); Linux — `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` ou `systemd-inhibit`; Windows — `powercfg /change standby-timeout-ac 0` e `powercfg /change hibernate-timeout-ac 0`. Na tomada, não na bateria.
- [ ] **Queda de energia:** religar sozinho — macOS `sudo pmset -a autorestart 1`; PC: BIOS/UEFI "Restore on AC power loss" = Power On.
- [ ] **Login automático** após reboot (o serviço sobe com o usuário): macOS — Usuários e Grupos (incompatível com FileVault); Windows — `netplwiz` ou Sysinternals Autologon; Linux — `sudo loginctl enable-linger $USER` (sobe sem login).
- [ ] **Atualizações automáticas do SO desligadas/pausadas** até depois do debate (macOS, Windows Update, unattended-upgrades).
- [ ] Permissão de microfone concedida ao `node` (macOS pergunta na 1ª captura de dispositivo).
- [ ] Rede cabeada se possível; acesso remoto (SSH/Tailscale/AnyDesk) como último recurso.
- [ ] Teste: no /admin, mande `running` para a máquina, confira nível de áudio e segmentos chegando; reinicie a máquina e veja voltar sozinha.
