// Versão do aviso jurídico. Mudou o texto do aviso? Suba a versão AQUI e no
// seletor html[data-disclaimer="..."] de app/globals.css — todo mundo vê de novo.
export const DISCLAIMER_VERSION = "v1";

export const DISCLAIMER_TEXT =
  "Sistema automatizado de checagem. Pode errar. Sempre verifique a fonte indicada em cada alerta.";

/**
 * Roda no <head> antes da pintura: aplica o tema escolhido e marca se o aviso
 * já foi aceito (evita piscar o modal para quem volta). Tudo em try/catch:
 * sem storage, vale o padrão (tema do sistema, aviso visível).
 */
export const BOOT_SCRIPT = `try{var d=document.documentElement;var t=localStorage.getItem("actually:theme");if(t==="light"||t==="dark")d.setAttribute("data-theme",t);var a=localStorage.getItem("actually:disclaimer");if(a)d.setAttribute("data-disclaimer",a);}catch(e){}`;
