# Atribuição: quem disse cada afirmação

Atribuir uma afirmação falsa ao candidato errado é um erro grave — pior, em alguns aspectos, que um alerta impreciso. Por isso o sistema **não nomeia o candidato por padrão**.

## Opção atual (MVP)

1. **Diarização**: o Deepgram separa os falantes e cada segmento chega com um `speaker_label` genérico qualificado pela **sessão do STT**: `s<n>-<agente>:S<k>` (ex.: `s1-a1b2c3:S0`, `s1-a1b2c3:S1`), onde `s<n>` é a n-ésima conexão do capture agent ao Deepgram, `<agente>` uma marca aleatória do agente (principal e standby têm marcas diferentes) e `S<k>` o falante dentro daquela sessão. O rótulo é estável dentro de uma sessão, mas **não** sabe quem é quem e pode confundir falas sobrepostas, apartes e o mediador. Toda reconexão ao Deepgram (queda do WS, watchdog do STT, reinício do agente) e todo failover abrem uma sessão nova e, portanto, **rótulos novos, sempre sem mapeamento**: o Deepgram renumera os falantes a cada sessão, então `S0` da sessão nova pode ser outra pessoa.
2. O `speaker_label` vai de `segments` para `claims` e `alerts`.
3. **Por padrão** o alerta diz **“Afirmação feita no debate”**, sem nome.
4. Para mostrar o nome, duas condições, **ambas**:
   - `show_attribution = true` nas settings do debate (`/admin`); e
   - o `speaker_label` do alerta está **mapeado** em `speaker_map` (`/editor` → mapeamento de speakers: `s1-a1b2c3:S0 → Lula`, `s1-a1b2c3:S1 → Flávio Bolsonaro`, `s1-a1b2c3:S2 → mediador`), com `confirmed_by` preenchido pelo editor que confirmou.
   Faltou qualquer uma → volta para “Afirmação feita no debate”.
5. O nome é resolvido **na leitura** (`AlertWithEvidence.person`), não gravado no alerta: corrigir o mapa corrige todos os alertas exibidos daquele `speaker_label`.

### Como o editor mapeia

- O painel do `/editor` agrupa os rótulos **por sessão de captura** (o prefixo `s1-…`, `s2-…`), da mais
  recente para a mais antiga, com quantos trechos, quanto tempo de fala e a última frase de cada voz —
  é por ela que se reconhece quem é quem. Rótulo com menos de 5 s de fala somados é tratado como
  **fragmento** da diarização (“Ok.”, “Olá,”) e fica recolhido, ainda mapeável: no ensaio de 18/10 a
  diarização devolveu 11 rótulos para 4 pessoas, e eram quase todos fragmentos. Quando a sessão mais
  recente tem voz longa sem mapa e alguma sessão anterior já estava mapeada, o painel avisa que é
  preciso remapear.
- No início do debate (apresentação dos candidatos), o editor ouve as primeiras falas, confere o `speaker_label` delas na transcrição do `/editor` e grava o mapa.
- **Remapear** (não só reconferir) após **toda** reconexão do capture agent ao Deepgram e **todo** failover para o standby: os segmentos passam a chegar com rótulos de uma sessão nova (`s2-…`, ou a marca do outro agente), que nunca herdam o mapa da sessão anterior — até o editor mapeá-los, os alertas saem como “Afirmação feita no debate”. A troca de sessão aparece no prefixo do rótulo (transcrição e mapeamento de speakers no `/editor`) e no contador de reconexões da máquina no `/admin`.
- **Reconferir** em blocos com muitos apartes.
- Na dúvida sobre um rótulo, **apagar o mapeamento** dele: os alertas voltam a sair sem nome.

### Limitações conhecidas

- Diarização erra em falas sobrepostas e em apartes curtos; um segmento pode conter dois falantes.
- Após reconexão ou failover, a sessão nova do Deepgram tem outros rótulos. O mapa é por `(debate, speaker_label)` e o rótulo leva a sessão, então nada do mapa antigo vale para a sessão nova (o `S0` dela pode ser outra pessoa): sem remapear, a atribuição some (nunca fica errada por isso). Reconexões frequentes (rede instável) significam remapear a cada uma.
- O mediador lendo uma pergunta com dados (“segundo o IBGE…”) pode gerar afirmação checável sem ser de
  candidato. **Mapear a mediação explicitamente** (`→ mediação`) resolve: o pipeline reconhece a pessoa
  como mediação e a fala dela não vira alerta. Enquanto a voz não tem mapa, uma fala que é só pergunta
  não chega nem ao extrator.

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
| Diarização troca falantes (MVP com nome) | Nome só com mapa confirmado; rótulo leva a sessão do STT, então reconexão/failover zera a atribuição até o editor remapear; na dúvida, sem nome. |
| Editor atribui errado sob pressão (HITL de atribuição) | Opção “não sei” sempre disponível e sem custo; trecho com tempo para conferir no player. |
| Afirmação de mediador atribuída a candidato | Mediador mapeado explicitamente; afirmações do mediador podem ser rejeitadas pelo editor. |
| Correção pública de atribuição errada | Rejeitar o alerta (sai do ar para todos) + nota pública; nunca apagar (trilha de auditoria). Ver [runbook](runbook-debate.md#alerta-errado-publicado). |
| Tratamento desigual entre candidatos | Mesmo fluxo, mesmas regras e mesmos limiares para os dois; relatório por speaker no eval (taxa de erro) e contagem por candidato no `/admin` para conferir caso a caso. Diferença de **volume** de alertas é esperada — o acervo público sobre cada trajetória é diferente — e não conta como risco. |

### Critério para adotar

Adotar o HITL de atribuição se, no ensaio, **qualquer** atribuição automática (mapa) estiver errada em mais de 2% dos alertas, ou se a equipe decidir que nomear é essencial — **e** houver editor com capacidade para o volume total de alertas (ver tabela de decisão em [human-in-the-loop.md](human-in-the-loop.md)). Caso contrário, manter o MVP: `show_attribution = false` por padrão.
