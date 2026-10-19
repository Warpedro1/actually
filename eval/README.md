# @actually/eval — avaliação de precisão e latência

Mede, antes do dia 23, se o pipeline acerta (precisão > latência > cobertura) e quanto tempo leva.
Tudo aqui roda `evaluateText` do `@actually/pipeline` em **modo seco**: lê a base de conhecimento,
mas não grava nada no banco e não publica alertas.

| Comando | O que faz |
|---|---|
| `pnpm eval -- --data eval/data/<arquivo>.jsonl [--concurrency 4] [--settings '{"t_red":0.9}'] [--out <dir>] [--target 0.9]` | Roda o conjunto, salva as decisões cruas e gera relatório |
| `pnpm --filter @actually/eval sweep -- --decisions eval/results/<ts>/decisions.jsonl [--target 0.9] [--target-yellow 0.85] [--from 0.5 --to 0.99 --step 0.01] [--penalties 0,0.05,0.1,0.15]` | Varre thresholds **sem chamar modelos** e recomenda valores |
| `pnpm --filter @actually/eval latency-report -- --debate <slug> [--json]` | Latência real de um ensaio/debate no Supabase (etapas, fim da fala → alerta, espera do editor, alertas/min) |
| `pnpm --filter @actually/eval test` | Testes das métricas (sem rede; `evaluateText` mockado) |

Os scripts leem o `.env` da raiz (chaves da Anthropic/Voyage/Tavily e do Supabase para o `evaluateText`; Supabase com service role para o `latency-report`).

## Saídas de `pnpm eval`

Em `eval/results/<timestamp>/` (ignorado pelo git):

- `decisions.jsonl` — uma linha por item: rótulo + `ClaimDecision[]` cru + tempo de parede + erro. É o cache que o `sweep` usa.
- `settings.json` — settings efetivas do run (defaults + `--settings`).
- `metrics.json` — todas as métricas em JSON.
- `report.md` — relatório legível:
  - precisão e recall de vermelhos, amarelos e “qualquer alerta”; matriz de confusão;
  - **falso alarme** em afirmações verdadeiras (`confirmado`), em falas não checáveis e na união das duas;
  - **taxa de silêncio** e distribuição de `silence_reason`;
  - latência p50/p95 por etapa (`latency_ms` do pipeline) e total (tempo de parede);
  - recortes **por speaker** (neutralidade) e **por tópico**;
  - lista de erros ordenada por gravidade (vermelho indevido primeiro), com afirmações extraídas, score, camada e evidências.

### Como as métricas são contadas

- A unidade é o **item** (uma fala). O alerta “emitido” para o item é o mais severo entre as afirmações que o pipeline extraiu dela (vermelho > amarelo > nenhum).
- Item em que `evaluateText` lançou conta como **silêncio** (é o que aconteceria ao vivo) e aparece como erro no relatório.
- Precisão sem nenhuma emissão é “—” (indefinida), não 0 nem 100%.
- Precisão **tolerante** do amarelo: amarelo emitido onde se esperava vermelho conta como acerto (a direção está certa).
- Latência por etapa: máximo entre as afirmações do item (caminho crítico). Não inclui STT (Deepgram) nem entrega; isso é medido no ensaio com o `latency-report`.

## Formato do conjunto rotulado (`eval/data/*.jsonl`)

Uma linha JSON por item:

```json
{
  "id": "d1018-042",
  "source": "debate-2026-10-18",
  "speaker": "Lula",
  "t": 1834.2,
  "topic": "economia",
  "context": "…transcrição dos ~60 s anteriores…",
  "text": "…a fala avaliada, como o capture agent entregaria…",
  "expected": { "checkable": true, "verdict": "contradito", "alert": "red" },
  "reference_urls": ["https://…fonte oficial ou checagem…"],
  "notes": "por que este rótulo; trecho da fonte; dúvidas",
  "synthetic": false
}
```

| Campo | Regra |
|---|---|
| `id` | Único no arquivo. Sugestão: `<fonte>-<nnn>`. |
| `source` | Origem: `debate-2026-10-18`, `debate-2022-<emissora>`, `entrevista-<veículo>-<data>`, `sintetico`. |
| `speaker` | Nome do candidato, `mediador`, ou `A`/`B` nos sintéticos. |
| `t` | Segundos desde o início da gravação de origem (para achar o trecho de novo). |
| `topic` | Opcional. Um dos tópicos-guia: `economia`, `impostos`, `programas-sociais`, `seguranca`, `corrupcao-justica`, `saude`, `meio-ambiente`, `educacao`, `politica-externa` (ou outro, se não couber). |
| `context` | Transcrição anterior (~60 s), igual à que a extração recebe ao vivo. Pode ser vazio. |
| `text` | A fala avaliada — um segmento da transcrição, sem editar (erros de STT fazem parte do teste). |
| `expected.checkable` | Há afirmação factual verificável? Opinião, promessa, ataque pessoal e cumprimento = `false`. |
| `expected.verdict` | `contradito` \| `impreciso` \| `confirmado` \| `inconclusivo`; `null` se não checável. |
| `expected.alert` | O que o público **deveria** ver: `"red"` (só com `contradito`), `"yellow"` (`impreciso`, ou `contradito` em que só cabe amarelo) ou `null`. |
| `reference_urls` | Fontes do rótulo. **Obrigatório** em item real checável (o parser rejeita sem). |
| `notes` | Justificativa curta, com o trecho da fonte. |
| `synthetic` | `true` só para exemplos inventados de teste do encanamento. |

O parser (`src/dataset.ts`) valida as combinações (ex.: `alert: "red"` exige `verdict: "contradito"`; `confirmado` exige `alert: null`) e aponta linha a linha o que está errado. `pnpm eval` recusa rodar com linhas inválidas.

`eval/data/smoke.jsonl` tem só exemplos **sintéticos** (speakers `A`/`B`, frases inventadas sobre fatos institucionais estáveis) para testar o encanamento. Ele **não mede qualidade** — o relatório avisa quando o conjunto é todo sintético.

## Processo de rotulagem (a partir do debate de 18/10)

Meta: **40–60 itens reais** até o dia 21, para calibrar thresholds no dia 22.

1. **Transcrever** o debate de ontem com o mesmo STT do ao vivo:
   `pnpm --filter @actually/kb-ingest start -- transcribe --file <video-ou-audio> --out data/raw/debate-2026-10-18.jsonl`
   (saída por segmento com `speaker_label`, `t_start`, `t_end`). Usar a mesma segmentação garante que `text` e `context` sejam o que o pipeline verá no dia 23.
2. **Selecionar** falas cobrindo, de forma **balanceada entre os dois candidatos** (diferença máxima de ±10% no número de itens e na proporção de cada rótulo):
   - ~35% afirmações **contraditas** pelas fontes (candidatas a vermelho);
   - ~15% **imprecisas** (número arredondado demais, período errado, comparação torta);
   - ~25% afirmações **verdadeiras** — essenciais para medir falso alarme;
   - ~25% falas **não checáveis** (opinião, promessa, ataque, retórica) e inconclusivas.
   Priorize os tópicos-guia e inclua números (L2), afirmações já checadas por agências (L1) e sobre o histórico dos candidatos (L3). Inclua também falas com erro de transcrição típico.
   Complete com trechos dos debates de 2022 se faltar volume, marcando `source` adequadamente.
3. **Rotular com fonte de referência**: para cada item checável, achar a fonte primária (IBGE, BCB, INPE, TSE, Senado, Planalto…) ou checagem de agência (tier 1) e preencher `reference_urls` e o trecho em `notes`. Sem fonte encontrada → `inconclusivo` e `alert: null` (o sistema também deve calar).
   Checagens publicadas sobre o debate de ontem são ótimas referências — mas cuidado: se a mesma checagem está na base L1, o item mede “achar a checagem”, não “verificar”. Marque em `notes` (`"na-base-L1"`) para separar no relatório depois.
4. **Duas pessoas para casos difíceis**: todo item `red` e todo item em que o rotulador hesitou é revisado por uma segunda pessoa, sem ver o rótulo da primeira. Divergência → discutir; sem consenso → `inconclusivo` / `alert: null` (na dúvida, silêncio — vale para o rótulo também). Registre em `notes` (`"revisado: X"`).
5. **Não** ajustar rótulos depois de ver a saída do sistema, exceto para corrigir erro de rotulagem comprovado com fonte (registrar em `notes`).
6. Separar um **conjunto de validação** (~20%, `eval/data/holdout.jsonl`) que não é usado para escolher thresholds — só para confirmar a escolha.

## Fluxo de calibração (dia 22)

1. `pnpm eval -- --data eval/data/debate-2026-10-18.jsonl` com os defaults.
2. Ler `report.md`: todo **vermelho indevido** é um bug a investigar (fonte errada? citação fora de contexto? afirmação mal extraída?), não só um ponto na curva.
3. `pnpm --filter @actually/eval sweep -- --decisions eval/results/<ts>/decisions.jsonl` → menor `t_red` com precisão ≥ 0,9 estável. As **regras duras** (citação verificada; tier ≤ 2 para vermelho) independem do threshold. Se a linha “concordância da regra local com o pipeline” ficar abaixo de 100%, o `score.ts` tem regras que a varredura não reproduz — confira antes de confiar na recomendação.
4. Confirmar no holdout com `--settings` dos valores escolhidos.
5. Registrar a decisão (valores, precisão, recall, data do run) em `docs/human-in-the-loop.md` e aplicar no /admin.
