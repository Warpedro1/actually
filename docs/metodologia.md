# Metodologia

> Texto-base da página pública `/metodologia`. Linguagem para o público geral. Ao mudar regras, thresholds ou fontes, atualize aqui **e** na página.

## O que é

Durante o debate presidencial de 23 de outubro de 2026, um sistema automatizado escuta a transmissão, identifica afirmações que podem ser checadas com dados — números, datas, fatos sobre leis, votações e programas — e as compara com fontes oficiais e checagens profissionais. Quando as fontes contradizem a afirmação, publicamos um alerta curto, **sempre com a fonte e o trecho que sustentam a correção**.

**O sistema é automatizado e pode errar.** Cada alerta traz o link da fonte: verifique sempre.

## Como funciona

1. **Transcrição.** O áudio da transmissão é transcrito automaticamente, em português, poucos segundos depois de cada fala.
2. **Seleção.** Um modelo de linguagem separa o que dá para julgar com dados ou fontes públicas do que não dá, e classifica cada fala:
   - **fato** ou **estatística** (“o desemprego caiu para X%”, “a lei foi aprovada em 2023”) — regras gerais;
   - **acusação** (situação judicial de uma pessoa: condenado, réu, investigado, inelegível, processo anulado ou arquivado) — julgamos **só o fato processual**, com órgão e data, nunca culpa ou intenção; vermelho só com decisão judicial, documento oficial ou checagem profissional; e **todo** alerta de acusação passa por um editor antes de ser publicado;
   - **opinião com base mensurável** (“não tem mais carne na mesa do brasileiro”) — comparada com o dado que a mede; no máximo “Impreciso”, com exigência maior de confiança;
   - **previsão** (“o país vai crescer 3% no ano que vem”) — comparada com projeções publicadas (Banco Central, IFI, Tesouro, FMI, agências de risco); no máximo “Impreciso”, com exigência maior de confiança;
   - **promessas** e **opiniões sem base mensurável** (adjetivos, ataques pessoais) não são checadas.
3. **Repetição.** Se a mesma afirmação — com os mesmos números — já foi verificada neste debate, reutilizamos o resultado e indicamos “Repetido — já verificado às HH:MM”. Afirmações parecidas com números diferentes são verificadas de novo.
4. **Busca de evidências**, em quatro camadas, nesta ordem de preferência:
   - checagens já publicadas por agências profissionais;
   - séries de indicadores oficiais (IBGE, Banco Central, INPE e outros) e **fatos de referência** (datas dos mandatos presidenciais e resultados oficiais do TSE), comparados com o número dito **por um programa, não pelo modelo**, com tolerância para arredondamento — ex.: “o partido X governou 20 dos últimos 24 anos” é conferido somando os mandatos;
   - documentos: debates anteriores, programas de governo registrados no TSE, entrevistas, votações e discursos no Congresso;
   - busca na web, **restrita** a fontes oficiais, de checagem e de imprensa de referência — e com exigência maior de confiança. Ela complementa a base quando as camadas anteriores não trazem evidência forte sobre aquela afirmação.
5. **Verificação.** Um modelo de linguagem compara a afirmação com as evidências e indica se ela é contradita, imprecisa, confirmada ou se não há base para concluir. Ele precisa citar o trecho exato da fonte que sustenta a conclusão.
6. **Conferência da citação.** Um programa confere se o trecho citado **existe de fato** na fonte. Se não existir, não há alerta.
7. **Decisão.** Um índice de confiança combina a segurança do modelo, a qualidade da fonte, a concordância entre fontes e a citação conferida. Só publicamos acima de um mínimo (abaixo). Afirmações confirmadas ou sem base suficiente **não geram alerta** — ficam só no registro interno.

### Tipos de alerta

| Selo | Quando |
|---|---|
| **Contradito pelas fontes** (vermelho) | Fonte oficial, checagem profissional ou imprensa de referência contradiz a afirmação, com trecho conferido. |
| **Impreciso** (amarelo) | A afirmação distorce o dado: número muito arredondado, período errado, comparação inadequada. |

Todo alerta mostra: a afirmação, uma linha com o dado correto, **a fonte (nome, link e trecho)** e o horário.

Não publicamos “verdadeiro”: o silêncio do sistema **não** significa que uma afirmação é verdadeira — pode só significar que não tínhamos como checá-la a tempo.

## Fontes e níveis de confiabilidade

Cada fonte tem um nível (tier). **Alertas vermelhos exigem fonte de nível 1 ou 2.** Fontes de nível 3 podem sustentar, no máximo, um alerta amarelo. Nível 4 nunca sustenta alerta sozinho.

Sites de governo só são nível 1 nos endereços listados abaixo, de órgãos que publicam **dado primário** (estatísticas, contas públicas, legislação), como IBGE, Banco Central, Tesouro, Portal da Transparência, a legislação do Planalto (`planalto.gov.br/ccivil_03`), INPE, DataSUS e ANP. **Comunicação de governo** — notícias e notas do governo federal (Secom, Planalto, ministérios em `gov.br`), de governos estaduais e de prefeituras — é parte interessada no debate, já que um dos candidatos é o atual governo: fica no nível 4, nunca sustenta alerta sozinha e não entra na busca na web.

<!-- tiers:begin (gerado por `pnpm --filter @actually/eval tiers-table`; não edite à mão) -->

| Tier | Fonte | Domínio | Tipo |
| --- | --- | --- | --- |
| 1 | AFP Checamos | `checamos.afp.com` | checagem |
| 1 | Agência Lupa | `lupa.uol.com.br` | checagem |
| 1 | ANP | `anp.gov.br` | oficial |
| 1 | Aos Fatos | `aosfatos.org` | checagem |
| 1 | Banco Central | `bcb.gov.br` | oficial |
| 1 | Biblioteca da Presidência da República | `biblioteca.presidencia.gov.br` | oficial |
| 1 | Câmara dos Deputados | `camara.leg.br` | oficial |
| 1 | DataSUS | `datasus.gov.br` | oficial |
| 1 | DataSUS | `datasus.saude.gov.br` | oficial |
| 1 | Estadão Verifica | `estadao.com.br/estadao-verifica` | checagem |
| 1 | Fato ou Fake (g1) | `g1.globo.com/fato-ou-fake` | checagem |
| 1 | Fórum Brasileiro de Segurança Pública | `forumseguranca.org.br` | acadêmico |
| 1 | IBGE | `ibge.gov.br` | oficial |
| 1 | INPE | `inpe.br` | oficial |
| 1 | Ipea | `ipea.gov.br` | oficial |
| 1 | Ipeadata | `ipeadata.gov.br` | oficial |
| 1 | Planalto (legislação) | `planalto.gov.br/ccivil_03` | oficial |
| 1 | Poder Judiciário | `jus.br` | oficial |
| 1 | Portal da Transparência | `portaldatransparencia.gov.br` | oficial |
| 1 | Projeto Comprova | `projetocomprova.com.br` | checagem |
| 1 | Senado Federal | `senado.leg.br` | oficial |
| 1 | STF | `stf.jus.br` | oficial |
| 1 | STJ | `stj.jus.br` | oficial |
| 1 | Tesouro Nacional | `tesouro.gov.br` | oficial |
| 1 | Tesouro Nacional | `tesourotransparente.gov.br` | oficial |
| 1 | TSE | `tse.jus.br` | oficial |
| 1 | UOL Confere | `noticias.uol.com.br/confere` | checagem |
| 2 | Agência Brasil | `agenciabrasil.ebc.com.br` | imprensa |
| 2 | BBC | `bbc.com` | imprensa |
| 2 | Estadão | `estadao.com.br` | imprensa |
| 2 | FGV | `fgv.br` | acadêmico |
| 2 | Folha de S.Paulo | `folha.uol.com.br` | imprensa |
| 2 | g1 | `g1.globo.com` | imprensa |
| 2 | Ministério Público | `mp.br` | oficial |
| 2 | Ministério Público Federal | `mpf.mp.br` | oficial |
| 2 | O Globo | `oglobo.globo.com` | imprensa |
| 2 | piauí | `piaui.folha.uol.com.br` | imprensa |
| 2 | Poder360 | `poder360.com.br` | imprensa |
| 2 | Reuters | `reuters.com` | imprensa |
| 2 | SciELO | `scielo.br` | acadêmico |
| 2 | Valor Econômico | `valor.globo.com` | imprensa |
| 3 | CNN Brasil | `cnnbrasil.com.br` | imprensa |
| 3 | Exame | `exame.com` | imprensa |
| 3 | InfoMoney | `infomoney.com.br` | imprensa |
| 3 | Metrópoles | `metropoles.com` | imprensa |
| 3 | UOL | `uol.com.br` | imprensa |
| 4 | Governo (gov.br) | `gov.br` | oficial |

Total: 47 domínios — tier 1 (Dado oficial primário ou checagem profissional): 27; tier 2 (Imprensa de referência ou academia): 14; tier 3 (Imprensa geral): 5; tier 4 (Qualquer outra fonte): 1. Domínio fora da lista = tier 4.

<!-- tiers:end -->

A lista completa de bases consultadas está em `docs/fontes.md`.

## Limiares de confiança

| Parâmetro | Valor padrão | Significado |
|---|---|---|
| Mínimo para vermelho | 0,85 | Índice de confiança mínimo para “Contradito pelas fontes”. |
| Mínimo para amarelo | 0,75 | Índice mínimo para “Impreciso”. |
| Acréscimo para fontes da web | +0,05 | Quando a evidência veio da busca web, o mínimo sobe. |
| Acréscimo para opinião e previsão | +0,10 | Opinião com base mensurável e previsão exigem mais confiança e nunca viram vermelho. |

Os valores foram calibrados com um conjunto de afirmações rotuladas por pessoas a partir do debate de 18 de outubro, para que **pelo menos 90% dos alertas vermelhos estejam corretos** nesse conjunto. Os valores em vigor no dia do debate serão publicados aqui.

Além dos limiares, há **regras fixas que nenhum ajuste muda**: nenhum alerta é publicado sem fonte com link e trecho conferido — essa regra é imposta pelo banco de dados, não apenas pelo programa.

## Revisão humana

Alertas vermelhos podem ser configurados para passar por um editor humano antes de serem publicados. Alertas sobre **acusações** (situação judicial de alguém) passam **sempre** pelo editor, com a revisão ligada ou não. Com a revisão ligada, o editor confere se a fonte sustenta a correção e aprova ou rejeita; **nada é publicado automaticamente por falta de tempo**. A decisão de usar a revisão no dia 23 depende dos testes de precisão e de tempo de resposta, e será informada nesta página.

Os editores não têm vínculo com as campanhas e seguem um critério único: aprovar só quando a fonte mostrada sustenta a correção.

## Quem disse

Por padrão, os alertas dizem “Afirmação feita no debate”, sem nome. A identificação automática de quem está falando pode errar, e atribuir uma afirmação à pessoa errada é um erro grave. O nome só aparece quando um editor confirmou a correspondência entre a voz e o candidato.

## Neutralidade

- As **mesmas regras, fontes e limiares** valem para todos os participantes.
- As regras de decisão (limiares, níveis de fonte, conferência da citação) não dependem de quem falou.
- Medimos a precisão e a taxa de alarme falso **separadamente por candidato** antes do debate; diferenças grandes são investigadas antes de ir ao ar.
- Contamos os alertas por candidato durante o debate. Um número diferente de alertas entre candidatos **não** é, por si, sinal de viés: reflete o que cada um afirmou e o que foi possível checar.

## Limitações

- **Pode errar.** Transcrição automática pode ouvir errado; o modelo pode interpretar mal uma afirmação; uma fonte pode estar desatualizada.
- **Não checa tudo.** Muitas afirmações não têm dado público, dependem de contexto ou levariam mais tempo do que o debate permite. Silêncio não é confirmação.
- **Atraso.** Os alertas chegam alguns segundos depois da fala — mais, se houver revisão humana.
- **Dados com defasagem.** Indicadores oficiais são divulgados com atraso; usamos o dado mais recente disponível na data do debate.
- **Contexto.** Um alerta trata de uma afirmação específica, não da fala inteira nem do candidato.
- **Repetição.** Uma afirmação repetida mostra o resultado da primeira verificação.

## Erros e correções

Se um alerta publicado estiver errado, ele é retirado do ar e uma **nota de correção** é publicada no lugar, explicando o erro. Não apagamos registros: todas as decisões ficam guardadas para auditoria.

**Encontrou um erro?** Escreva para **[e-mail de contato — a definir]** com o horário do alerta e o motivo. Respondemos às solicitações durante e depois do debate.
