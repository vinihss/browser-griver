/**
 * A tela de "servidor não disponível".
 *
 * Ela vive fora do `#root` do painel: dentro dele, o próximo redesenho
 * (`clear(root)`) apagaria a tela — e o `overflow: hidden` ficaria, deixando
 * o painel travado sem scroll e sem explicação nenhuma.
 */
import { state, patch, setNotice } from "./state.js"
import { refreshProjects } from "./views/projects.js"
import { STORAGE } from "../shared/constants.js"

/** O servidor responde? */
export async function servidorResponde(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Mostra a tela de servidor fora do ar.
 *
 * A mensagem do navegador ("Failed to fetch") não diz nada ao usuário: o
 * que ele precisa saber é onde o servidor não respondeu.
 */
export function mostrarAvisoDeServidor(url: string): void {
  esconderAvisoDeServidor()

  const overlay = document.createElement("div")
  overlay.id = "aviso-servidor"
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(20, 22, 26, 0.95);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `

  const msg = document.createElement("div")
  msg.style.cssText = `
    text-align: center;
    max-width: 90%;
    padding: 20px;
    background: rgba(242, 85, 90, 0.15);
    border: 1px solid #f2555a;
    border-radius: 8px;
  `
  msg.innerHTML = `
    <h3 style="margin: 0 0 10px 0; color: #f2555a;">⚠️ Servidor não disponível</h3>
    <p style="margin: 0 0 15px 0; color: #98a1b0;">Não foi possível conectar ao servidor Griver.</p>
    <label style="display: block; text-align: left; margin: 0 0 12px 0; color: #98a1b0; font-size: 12px;">
      Endereço do servidor
      <input id="aviso-url" type="text" style="
        display: block;
        width: 100%;
        margin-top: 4px;
        padding: 7px 9px;
        background: #14161a;
        border: 1px solid #2b303a;
        border-radius: 4px;
        color: #e6e9ef;
        font: inherit;
        font-size: 13px;
      ">
    </label>
    <button id="btn-retry" style="
      margin-top: 4px;
      padding: 8px 16px;
      background: #f2555a;
      color: #0d1017;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
    ">Tentar novamente</button>
  `

  // o campo começa com o endereço de agora: é o que o painel está usando
  const urlInput = msg.querySelector("#aviso-url") as HTMLInputElement | null
  if (urlInput) urlInput.value = url

  const btnRetry = msg.querySelector("#btn-retry")
  btnRetry?.addEventListener("click", async () => {
    btnRetry.setAttribute("disabled", "disabled")
    // o endereço é o do campo: o servidor pode estar em outro lugar
    const alvo = urlInput?.value.trim() || enderecoDoServidor()
    if (await servidorResponde(alvo)) {
      // o endereço corrigido passa a valer para o painel e para a extensão
      state.serverUrl = alvo
      await chrome.storage.local.set({ [STORAGE.serverUrl]: alvo })
      esconderAvisoDeServidor()
      patch({ notice: undefined })
      void refreshProjects()
      return
    }
    btnRetry.removeAttribute("disabled")
    setNotice(`O servidor Griver em ${alvo} continua sem responder.`, "error")
  })

  overlay.appendChild(msg)
  document.body.appendChild(overlay)
}

/** Tira a tela de "servidor não disponível" e devolve o scroll do painel. */
export function esconderAvisoDeServidor(): void {
  document.getElementById("aviso-servidor")?.remove()
  const root = document.getElementById("root")
  if (root) root.style.overflow = ""
}

/** O painel está mostrando a tela de servidor fora do ar? */
export function avisoDeServidorVisivel(): boolean {
  return Boolean(document.getElementById("aviso-servidor"))
}

/** O endereço que o painel está usando. */
export function enderecoDoServidor(): string {
  return state.serverUrl || "http://127.0.0.1:7331"
}
