# Metodologia

> Texto-base da página pública `/metodologia`. Linguagem para o público geral. Ao mudar regras, thresholds ou fontes, atualize aqui **e** na página.

## O que é

Durante o debate presidencial de 23 de outubro de 2026, um sistema automatizado escuta a transmissão, identifica afirmações que podem ser checadas com dados — números, datas, fatos sobre leis, votações e programas — e as compara com fontes oficiais e checagens profissionais. Quando as fontes contradizem a afirmação, publicamos um alerta curto, **sempre com a fonte e o trecho que sustentam a correção**.

**Projeto em desenvolvimento.** O sistema é automatizado e pode errar. Cada alerta traz o link da fonte: verifique sempre.

## Como funciona

1. **Transcrição.** O áudio da transmissão é transcrito automaticamente, em português, poucos segundos depois de cada fala.
2. **Seleção.** Um modelo de linguagem separa o que dá para julgar com dados ou fontes públicas do que não dá, e classifica cada fala:
   - **fato** ou **estatística** (“o desemprego caiu para X%”, “a lei foi aprovada em 2023”) — regras gerais;
   - **acusação** (situação judicial de uma pessoa: condenado, réu, investigado, inelegível, processo anulado ou arquivado) — julgamos **só o fato processual**, com órgão e data, nunca culpa ou intenção; o vermelho exige fonte de nível 1 a 3 com trecho conferido (decisão judicial, documento oficial, checagem profissional ou imprensa), e **todo** alerta de acusação passa por um editor antes de ser publicado, com a aprovação de vermelhos ligada ou desligada;
   - **opinião com base mensurável** (“não tem mais carne na mesa do brasileiro”) — comparada com o dado que a mede; no máximo “Impreciso”, com exigência maior de confiança;
   - **previsões** (“o país vai crescer 3% no ano que vem”), **promessas** e **opiniões sem base mensurável** (adjetivos, ataques pessoais) não são checadas: não dá para verificar o que ainda não aconteceu, nem juízo de valor. Também ficam fora **hipóteses** (“pode ser”, “talvez”), **condicionais** (“se o PIB cresceu…”) e falas da **mediação**.
   - **perguntas** não viram afirmação, mas o **fato que a pergunta pressupõe** vira (“caiu o roubo de celular?” → “o roubo de celulares não caiu”), e esse alerta sempre passa por um editor.

   A afirmação reescrita para a checagem não pode dizer mais do que a fala: se ela acrescenta um ano, um período, o turno de uma eleição ou um nome que ninguém disse, é descartada.
3. **Repetição.** Se a mesma afirmação — com os mesmos números — já foi verificada neste debate, reutilizamos o resultado e indicamos “Repetido — já verificado às HH:MM”. Afirmações parecidas com números diferentes são verificadas de novo.
4. **Busca de evidências**, em quatro camadas, nesta ordem de preferência:
   - checagens já publicadas por agências profissionais;
   - séries de indicadores oficiais (IBGE, Banco Central, INPE e outros) e **fatos de referência** (datas dos mandatos presidenciais e resultados oficiais do TSE), comparados com o número dito **por um programa, não pelo modelo**, com tolerância para arredondamento — ex.: “o partido X governou 20 dos últimos 24 anos” é conferido somando os mandatos;
   - documentos: debates anteriores, programas de governo registrados no TSE, entrevistas, votações e discursos no Congresso;
   - busca na web, **restrita** a fontes oficiais, de checagem e de imprensa de referência — e com exigência maior de confiança. Ela complementa a base quando as camadas anteriores não trazem evidência forte sobre aquela afirmação. As páginas que essa busca encontra (só dessas fontes) passam a fazer parte da base, para as próximas checagens.
5. **Verificação.** Um modelo de linguagem compara a afirmação com as evidências e indica se ela é contradita, imprecisa, confirmada ou se não há base para concluir. Ele precisa citar o trecho exato da fonte que sustenta a conclusão. Não valem como evidência, mesmo estando na página: o boato que uma checagem reproduz para desmentir, a fala ou alegação de candidato, defesa ou partido relatada pela matéria, voto vencido e manchetes de outras matérias. Em situação judicial, vale a informação mais recente. Ao guardar uma página, retiramos as listas de "Leia mais" e o texto de propaganda.
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

Cada fonte tem um nível (tier). **Alerta vermelho exige fonte de nível 1, 2 ou 3 com citação conferida**; o nível 4 nunca sustenta alerta. O nível pesa na pontuação (1 vale 1; 2, 0,85; 3, 0,6), então uma fonte de nível 3 sozinha quase nunca alcança o limiar do vermelho: na prática precisa de duas camadas que concordem. Acusação segue os mesmos níveis, com duas exigências a mais: o verificador só a julga por fato processual com órgão e data, e o alerta **sempre** passa pelo editor, com a aprovação de vermelhos ligada ou desligada.

Sites de governo só são nível 1 nos endereços listados abaixo, de órgãos que publicam **dado primário** (estatísticas, contas públicas, legislação), como IBGE, Banco Central, Tesouro, Portal da Transparência, a legislação do Planalto (`planalto.gov.br/ccivil_03`), INPE, DataSUS e ANP — inclusive nos endereços do portal `gov.br` para onde a ANP e o Tesouro mudaram (`gov.br/anp`, `gov.br/tesouronacional`). **Comunicação de governo** — notícias e notas do governo federal (Secom, Planalto, ministérios em `gov.br`), de governos estaduais e de prefeituras — é parte interessada no debate, já que um dos candidatos é o atual governo: fica no nível 4, nunca sustenta alerta sozinha e não entra na busca na web.

**Conteúdo patrocinado** publicado no site de um jornal (estúdios de conteúdo de marca, como o Blue Studio do Estadão) é publicidade: nível 4. Arquivos de terceiros apenas hospedados por um jornal — como os PDFs de programas de governo e de documentos oficiais em `static.poder360.com.br` — não herdam o nível do jornal: nível 3.

<!-- tiers:begin (gerado por `pnpm --filter @actually/eval tiers-table`; não edite à mão) -->

| Tier | Fonte | Domínio | Tipo |
| --- | --- | --- | --- |
| 1 | AFP Checamos | `checamos.afp.com` | checagem |
| 1 | Agência Lupa | `agencialupa.org` | checagem |
| 1 | Agência Lupa | `lupa.uol.com.br` | checagem |
| 1 | ANP | `anp.gov.br` | oficial |
| 1 | ANP | `gov.br/anp` | oficial |
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
| 1 | Tesouro Nacional | `gov.br/tesouronacional` | oficial |
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
| 3 | Poder360 (arquivos de terceiros) | `static.poder360.com.br` | outro |
| 3 | UOL | `uol.com.br` | imprensa |
| 4 | Estadão Blue Studio (patrocinado) | `bluestudio.estadao.com.br` | outro |
| 4 | Governo (gov.br) | `gov.br` | oficial |

Total: 52 domínios — tier 1 (Dado oficial primário ou checagem profissional): 30; tier 2 (Imprensa de referência ou academia): 14; tier 3 (Imprensa geral): 6; tier 4 (Qualquer outra fonte): 2. Domínio fora da lista = tier 4.

<!-- tiers:end -->

A lista completa de bases consultadas está em `docs/fontes.md`.

## Limiares de confiança

| Parâmetro | Valor padrão | Significado |
|---|---|---|
| Mínimo para vermelho | 0,85 | Índice de confiança mínimo para “Contradito pelas fontes”. |
| Mínimo para amarelo | 0,75 | Índice mínimo para “Impreciso”. |
| Acréscimo para fontes da web | +0,05 | Quando a evidência veio da busca web, o mínimo sobe — exceto quando a fonte citada é uma checagem de agência profissional (nível 1) com o trecho conferido: o acréscimo compensa a busca aberta, não a qualidade da fonte. |
| Acréscimo para opinião mensurável | +0,10 | Opinião com base mensurável exige mais confiança e nunca vira vermelho. |

Os valores foram calibrados com um conjunto de afirmações rotuladas por pessoas a partir do debate de 18 de outubro, para que **pelo menos 90% dos alertas vermelhos estejam corretos** nesse conjunto. A tabela acima e a página pública mostram os **valores padrão**; a equipe pode ajustá-los por debate, sempre igualmente para todos os participantes, e qualquer ajuste relevante é informado na observação do próprio debate.

Além dos limiares, há **regras fixas que nenhum ajuste muda**: nenhum alerta é publicado sem fonte com link e trecho conferido — essa regra é imposta pelo banco de dados, não apenas pelo programa.

## Revisão humana

Alertas vermelhos podem ser configurados para passar por um editor humano antes de serem publicados. Um vermelho de fato ou estatística que fica **logo abaixo do limiar** (até 5 pontos) não é publicado automaticamente: vai para o editor, com a revisão ligada ou não, e só sai se ele aprovar. Alertas sobre **acusações** (situação judicial de alguém) passam **sempre** pelo editor, com a revisão ligada ou não. Com a revisão ligada, o editor confere se a fonte sustenta a correção e aprova ou rejeita; **nada é publicado automaticamente por falta de tempo**. A decisão de usar a revisão no dia 23 depende dos testes de precisão e de tempo de resposta, e será informada nesta página.

Os editores não têm vínculo com as campanhas e seguem um critério único: aprovar só quando a fonte mostrada sustenta a correção.

## Quem disse

Por padrão, os alertas dizem “Afirmação feita no debate”, sem nome. A identificação automática de quem está falando pode errar, e atribuir uma afirmação à pessoa errada é um erro grave. O nome só aparece quando um editor confirmou a correspondência entre a voz e o candidato.

## Neutralidade

Neutralidade é **julgar os participantes pela mesma régua**, não sobre os mesmos dados.

- As **mesmas regras, o mesmo catálogo de fontes e os mesmos limiares** valem para todos. As regras de decisão (limiares, níveis de fonte, conferência da citação) não dependem de quem falou — está travado em teste (RNF04: a mesma afirmação com falantes diferentes dá a mesma decisão).
- O **conteúdo** disponível sobre cada um não é simétrico, e não há como torná-lo: as trajetórias são diferentes. Sobre quem já exerceu um cargo existe muito mais dado público e muito mais checagem publicada do que sobre quem não exerceu.
- Daí decorre que **um número diferente de alertas entre candidatos é esperado e não é sinal de parcialidade**: reflete o que cada um afirmou e o quanto daquilo é verificável com fonte.
- O que se investiga é **taxa de erro**, não volume: medimos precisão e alarme falso **separadamente por candidato** antes do debate, e diferença grande na taxa de erro é investigada antes de ir ao ar.
- Durante o debate, a contagem por pessoa no `/admin` serve para achar alertas errados e conferi-los um por um — nunca para igualar os números.

## Limitações

- **Pode errar.** Transcrição automática pode ouvir errado; o modelo pode interpretar mal uma afirmação; uma fonte pode estar desatualizada.
- **Não checa tudo.** Muitas afirmações não têm dado público, dependem de contexto ou levariam mais tempo do que o debate permite. Silêncio não é confirmação.
- **Atraso.** Os alertas chegam em geral de 10 a 20 segundos depois da fala — mais, se houver revisão humana. Buscar e conferir a fonte leva tempo, e preferimos chegar um pouco depois a errar.
- **Dados com defasagem.** Indicadores oficiais são divulgados com atraso; usamos o dado mais recente disponível na data do debate.
- **Contexto.** Um alerta trata de uma afirmação específica, não da fala inteira nem do candidato.
- **Repetição.** Uma afirmação repetida mostra o resultado da primeira verificação.

## Erros e correções

Se um alerta publicado estiver errado, ele é retirado do ar e uma **nota de correção** é publicada no lugar, explicando o erro. Não apagamos registros: todas as decisões ficam guardadas para auditoria.

**Encontrou um erro?** Escreva para **[e-mail de contato — a definir]** com o horário do alerta e o motivo. Respondemos às solicitações durante e depois do debate.
