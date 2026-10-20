/**
 * User-agent de um Chrome de verdade.
 *
 * O Chromium que vem com o Playwright se anuncia como "HeadlessChrome" — e
 * site com proteção de bot (Cloudflare, e o da Workana é um) responde com a
 * tela de verificação em vez do conteúdo. A receita morre no `waitFor` com
 * "nenhum seletor casou", sem nunca mencionar o user-agent como culpado.
 */
export const USER_AGENT_REAL =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"

/**
 * O user-agent a usar no contexto.
 *
 * Com tela, o navegador já se anuncia como deve — e mexer nisso seria
 * trocar a identidade do Chrome do usuário por uma de mentira. Sem tela,
 * o "HeadlessChrome" entrega a receita para o bot.
 */
export function userAgentDe(headed: boolean | undefined): string | undefined {
  return headed ? undefined : USER_AGENT_REAL
}
