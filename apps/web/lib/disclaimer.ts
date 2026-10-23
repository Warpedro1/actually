// Versão do aviso jurídico. Mudou o texto do aviso? Suba a versão AQUI e no
// seletor html[data-disclaimer="..."] de app/globals.css — todo mundo vê de novo
// (quem já tinha aceitado a versão anterior vê o modal outra vez, que é o ponto).
export const DISCLAIMER_VERSION = "v3";

/** Quem é o projeto e o que ele se propõe a fazer. */
export const DISCLAIMER_INTRO = [
  "O Actually é um projeto pessoal de engenharia de software. É independente e não tem vínculo com partidos, campanhas, candidatos ou veículos de imprensa.",
  "O objetivo é testar se dá para corrigir números e fatos verificáveis durante um debate ao vivo, com fonte, em segundos, de forma automática, com inteligência artificial.",
] as const;

/**
 * As quatro coisas que o leitor precisa saber antes de olhar um alerta. A
 * segunda fala em "mesmo catálogo de fontes", não "mesmas fontes": o processo e
 * os critérios são idênticos para os dois, mas o que existe publicado sobre
 * cada um não é — e é por isso que a contagem de alertas pode ser diferente
 * sem que isso seja parcialidade (ver docs/metodologia.md, Neutralidade).
 */
export const DISCLAIMER_POINTS = [
  "Todo alerta traz a fonte, o link e o trecho que sustenta a correção.",
  "Os dois participantes passam pelo mesmo processo, com os mesmos critérios e o mesmo catálogo de fontes. O que existe publicado sobre cada um não é igual, então a quantidade de alertas pode ser diferente.",
  "A ausência de alerta não significa que a fala é verdadeira: significa que não houve fonte suficiente para corrigir com segurança.",
  "O sistema é experimental e pode errar. Verifique a fonte de cada alerta antes de repassar. Alerta que se mostra errado é retirado do ar.",
] as const;

/** Resumo de uma linha (faixa permanente e qualquer outro lugar que precise do aviso curto). */
export const DISCLAIMER_TEXT =
  "Projeto em desenvolvimento. Sistema automatizado de checagem. Pode errar. Sempre verifique a fonte indicada em cada alerta.";

/**
 * Roda no <head> antes da pintura: aplica o tema escolhido e marca se o aviso
 * já foi aceito (evita piscar o modal para quem volta). Tudo em try/catch:
 * sem storage, vale o padrão (tema do sistema, aviso visível).
 */
export const BOOT_SCRIPT = `try{var d=document.documentElement;var t=localStorage.getItem("actually:theme");if(t==="light"||t==="dark")d.setAttribute("data-theme",t);var a=localStorage.getItem("actually:disclaimer");if(a)d.setAttribute("data-disclaimer",a);}catch(e){}`;
