# Atribuição: quem disse cada afirmação

Atribuir uma afirmação falsa ao candidato errado é um erro grave — pior, em alguns aspectos, que um alerta impreciso. Por isso o sistema **não nomeia o candidato por padrão**.

## Opção atual (MVP)

1. **Diarização**: o Deepgram separa os falantes e cada segmento chega com um `speaker_label` genérico (`0`, `1`, `2`…). O rótulo é estável dentro de uma sessão de captura, mas **não** sabe quem é quem, pode trocar após uma reconexão e pode confundir falas sobrepostas, apartes e o mediador.
2. O `speaker_label` vai de `segments` para `claims` e `alerts`.
3. **Por padrão** o alerta diz **“Afirmação feita no debate”**, sem nome.
4. Para mostrar o nome, duas condições, **ambas**:
   - `show_attribution = true` nas settings do debate (`/admin`); e
   - o `speaker_label` do alerta está **mapeado** em `speaker_map` (`/editor` → mapeamento de speakers: `0 → Lula`, `1 → Flávio Bolsonaro`, `2 → mediador`), com `confirmed_by` preenchido pelo editor que confirmou.
   Faltou qualquer uma → volta para “Afirmação feita no debate”.
5. O nome é resolvido **na leitura** (`AlertWithEvidence.person`), não gravado no alerta: corrigir o mapa corrige todos os alertas exibidos daquele `speaker_label`.

### Como o editor mapeia

- No início do debate (apresentação dos candidatos), o editor ouve as primeiras falas, confere o `speaker_label` delas na transcrição do `/editor` e grava o mapa.
- **Reconferir** após: reconexão do capture agent, failover para o standby (outra sessão do Deepgram ⇒ rótulos podem mudar), blocos com muitos apartes.
- Na dúvida sobre um rótulo, **apagar o mapeamento** dele: os alertas voltam a sair sem nome.

### Limitações conhecidas

- Diarização erra em falas sobrepostas e em apartes curtos; um segmento pode conter dois falantes.
- Após failover, o standby tem outra sessão do Deepgram e outros rótulos. O mapa é por `(debate, speaker_label)`, então o rótulo `0` do standby pode ser outra pessoa — por isso a reconferência é obrigatória depois de failover.
- O mediador lendo uma pergunta com dados (“segundo o IBGE…”) pode gerar afirmação checável sem ser de candidato.

## Alternativa para depois dos testes: HITL de atribuição

Se os ensaios mostrarem que a diarização erra demais (ou se a equipe quiser nomear sempre), a alternativa é o **editor escrever ou validar quem disse cada afirmação antes da publicação**.

### Fluxo

1. Alerta criado vai para a fila do `/editor` como hoje, com o `speaker_label` e a **sugestão** do mapa (se houver).
2. O editor ouve/lê o trecho (transcrição com 15 s antes e depois, e o tempo `t_start`/`t_end` para conferir no player) e escolhe: **Lula**, **Flávio Bolsonaro**, **mediador/outro**, ou **não sei**.
3. Publicação:
   - com pessoa escolhida → alerta publicado **com nome**;
   - com “não sei” → publicado como “Afirmação feita no debate” (ou rejeitado, se a afirmação depender de quem disse — ex.: “eu votei contra”).
4. A atribuição fica registrada (quem atribuiu, quando) e auditada em `alert_events`.

Para ser útil, a atribuição tem que valer para **todos** os alertas (vermelhos e amarelos), o que significa que **todo** alerta passa pelo editor — na prática, `require_red_approval = true` e `require_yellow_approval = true`.

### Custo em latência

- Soma uma decisão humana por alerta: estimativa de **+5 a +15 s** em cada alerta (o editor já está olhando o alerta; atribuir é um clique a mais quando a sugestão está certa, mais quando precisa ouvir de novo).
- Amarelos, que hoje saem sem espera, passam a esperar também.
- Medir no ensaio com o `latency-report` (espera do editor) com e sem a etapa de atribuição.

### Mudanças necessárias

Schema (nova migration — **não** implementado):

```sql
alter table alerts
  add column attributed_person text,
  add column attributed_by uuid references auth.users (id),
  add column attributed_at timestamptz;
-- opcional: exigir atribuição para publicar quando a setting pedir
-- (estender alerts_require_evidence ou criar trigger próprio lendo debates.settings->>'require_attribution')
```

- Nova setting `require_attribution: boolean` em `DebateSettings` (`packages/db/src/types.ts`) e no default de `debates.settings`.
- `AlertWithEvidence.person`: usar `attributed_person` quando existir; senão a regra atual (mapa + `show_attribution`).
- Política RLS: `alerts_editor_update` já cobre o update pelo editor.
- `/editor`: seletor de pessoa com atalhos (ex.: `1` Lula, `2` Flávio, `3` mediador, `0` não sei), pré-selecionado pela sugestão do mapa; trecho de transcrição em volta com tempo.
- `/ao-vivo`: nenhuma mudança de layout (o campo `person` já existe).
- Pipeline: nenhuma mudança (continua gravando `speaker_label`).

### Riscos de atribuição errada

| Risco | Mitigação |
|---|---|
| Diarização troca falantes (MVP com nome) | Nome só com mapa confirmado; reconferir após reconexão/failover; na dúvida, sem nome. |
| Editor atribui errado sob pressão (HITL de atribuição) | Opção “não sei” sempre disponível e sem custo; trecho com tempo para conferir no player. |
| Afirmação de mediador atribuída a candidato | Mediador mapeado explicitamente; afirmações do mediador podem ser rejeitadas pelo editor. |
| Correção pública de atribuição errada | Rejeitar o alerta (sai do ar para todos) + nota pública; nunca apagar (trilha de auditoria). Ver [runbook](runbook-debate.md#alerta-errado-publicado). |
| Assimetria entre candidatos | Mesmo fluxo para os dois; relatório por speaker no eval e contagem por candidato no `/admin`. |

### Critério para adotar

Adotar o HITL de atribuição se, no ensaio, **qualquer** atribuição automática (mapa) estiver errada em mais de 2% dos alertas, ou se a equipe decidir que nomear é essencial — **e** houver editor com capacidade para o volume total de alertas (ver tabela de decisão em [human-in-the-loop.md](human-in-the-loop.md)). Caso contrário, manter o MVP: `show_attribution = false` por padrão.
