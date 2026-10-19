# Human-in-the-loop (HITL) dos alertas

## O que é

Com o HITL ligado, um alerta **não vai ao público** quando o pipeline o cria: ele entra como `pending_review` na fila do `/editor`, e só é publicado quando um editor aprova. Serve para segurar o erro mais caro do sistema — um **vermelho errado** ao vivo — ao custo de alguns segundos de latência e de uma pessoa dedicada.

O HITL é uma **chave**, não uma decisão de arquitetura. A decisão de usar no dia 23 sai dos testes (ver [Critérios de decisão](#critérios-para-decidir-depois-dos-testes)).

## As chaves

Em `debates.settings` (editáveis no `/admin`, valem imediatamente para os próximos alertas):

| Chave | Padrão | Efeito |
|---|---|---|
| `require_red_approval` | `true` | Vermelhos (contradito) entram como `pending_review`. |
| `require_yellow_approval` | `false` | Idem para amarelos (impreciso). |

Com a chave desligada, o alerta é criado já como `published` — e o trigger do banco continua exigindo evidência com citação verificada, **com ou sem HITL**. A aprovação do editor também passa pelo trigger: um editor não consegue publicar um alerta sem fonte verificada.

Mudar a chave **não** altera alertas que já estão na fila: pendentes continuam pendentes até alguém decidir.

## Fluxo no /editor

1. Alerta pendente aparece no topo da fila (Realtime), com: afirmação, veredito, correção proposta, **fonte (nome, link, trecho)**, tier, camada, score, trecho da transcrição em volta e há quanto tempo está esperando.
2. O editor lê a afirmação e **abre a fonte** quando houver qualquer dúvida.
3. Decide:

| Atalho | Ação | Resultado |
|---|---|---|
| `A` | Aprovar | `published` (Realtime entrega na hora). Registra `reviewed_by`/`reviewed_at`. |
| `R` | Rejeitar | `rejected` com motivo (obrigatório, curto). Não aparece para o público. |
| `E` | Editar resumo/correção | Ajusta o texto (não a fonte) e volta para a decisão. |
| `J` / `K` | Próximo / anterior | Navega na fila. |
| `O` | Abrir fonte | Abre o link da evidência em nova aba. |

Os atalhos acima são o padrão especificado para o `/editor`; confira na própria tela antes do ensaio e corrija esta tabela se a implementação divergir.

4. Toda decisão vai para `alert_events` (antes/depois, quem, quando).

### Nunca auto-publicar por timeout

Um alerta pendente **nunca** vira publicado sozinho, por mais que espere. Se o editor não conseguir avaliar a tempo, o alerta fica pendente (ou é rejeitado com motivo “sem tempo para verificar”). Alerta atrasado é melhor que alerta errado; alerta que ninguém viu é melhor que alerta errado.

Se a fila acumular, a regra é: **priorizar os mais recentes** (o assunto ainda está em discussão) e rejeitar com motivo “expirado” os que perderam o contexto (mais de ~3 minutos, a critério do editor).

## SLA do editor

| Medida | Meta |
|---|---|
| Tempo de decisão (criado → revisado), p50 | ≤ 15 s |
| Tempo de decisão, p95 | ≤ 30 s |
| Fila máxima tolerada | 3 pendentes |
| Disponibilidade | Durante todo o debate, com substituto combinado para pausas |

Medido pelo `latency-report` (“Espera do editor”):

```bash
pnpm --filter @actually/eval latency-report -- --debate <slug>
```

## Perfil do editor

- Jornalista ou pesquisador com experiência em checagem; conhece as fontes oficiais (IBGE, BCB, INPE, TSE) e lê uma série histórica sem ajuda.
- **Sem vínculo** com nenhuma das campanhas; compromisso explícito de aplicar o mesmo critério aos dois candidatos.
- Treinado no `/editor` durante os ensaios (dias 21 e 22), com os atalhos.
- Critério único: **aprovar só se a fonte mostrada sustenta a correção**. Não é o momento de ampliar a checagem nem de discordar do enquadramento político; na dúvida, rejeita.
- Usuário cadastrado em `editors`, com 2FA se `REQUIRE_MFA=1` (ver [setup.md](setup.md)).
- Recomendado: **dois editores** (um decide, outro acompanha e assume em pausas), na mesma chamada de voz.

## Critérios para decidir depois dos testes

Insumos:

1. **Precisão de vermelhos no eval** — `pnpm eval` no conjunto rotulado do debate de 18/10 (+ holdout), com os thresholds escolhidos no `sweep`. Ver `eval/README.md`.
2. **Precisão no ensaio** — no replay ponta a ponta (dia 21/22), com HITL **ligado**: a taxa de rejeição do editor sobre vermelhos é uma medida independente de precisão (rejeitados por erro / total revisado).
3. **Latência adicional** — `latency-report`: espera do editor (p50/p95) e “fim da fala → publicado” comparado com “fim da fala → alerta criado”.
4. **Volume** — alertas novos por minuto (média, p95 e pico em 60 s) do `latency-report` vs. capacidade do editor (~3–4 decisões/minuto com qualidade).

### Tabela de decisão

| Precisão de vermelhos (eval e ensaio) | Volume de vermelhos (pico/min) | Latência extra do HITL (p95) | Decisão para o dia 23 |
|---|---|---|---|
| < 90% em qualquer um | qualquer | qualquer | **HITL ligado** e subir `t_red` até o sweep atingir 90%. Se nem assim, vermelhos só com aprovação **e** considerar desligar vermelhos (só amarelos). |
| ≥ 90% e < 97% | ≤ 3 | ≤ 30 s | **HITL ligado.** |
| ≥ 90% e < 97% | > 3 | qualquer | **HITL ligado** + subir `t_red` para reduzir volume (o sweep mostra o custo em cobertura) + segundo editor. |
| ≥ 97% em ambos, com ≥ 15 vermelhos avaliados | ≤ 3 | ≤ 30 s | Pode ficar **ligado** (custo baixo). Desligar só se a latência for um problema real para o público. |
| ≥ 97% em ambos, com ≥ 15 vermelhos avaliados | qualquer | > 30 s | **HITL desligado** para vermelhos com tier 1 e citação verificada, editor em modo **revisão posterior** (rejeita publicados errados — ver [runbook](runbook-debate.md#alerta-errado-publicado)). |
| Poucos vermelhos avaliados (< 15) | — | — | Amostra pequena para afirmar precisão: **HITL ligado**. |

Amarelos (`require_yellow_approval`): começam **desligados**. Ligar se a precisão tolerante do amarelo no eval for < 85% ou se o ensaio mostrar amarelos sem sentido.

Sem editor disponível no dia → **não** desligar o HITL para compensar: subir `t_red` e aceitar menos vermelhos, ou publicar só amarelos.

### Registro da decisão

Preencher no dia 22, após o ensaio 2:

| Item | Valor |
|---|---|
| Run do eval (pasta) | |
| `t_red` / `t_yellow` / `web_penalty` | |
| Precisão de vermelhos eval (holdout) | |
| Taxa de rejeição de vermelhos no ensaio | |
| Espera do editor p50 / p95 | |
| Pico de alertas/min | |
| `require_red_approval` / `require_yellow_approval` | |
| Responsável pela decisão | |
