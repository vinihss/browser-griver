import { mount } from "./app.js"
import { state, patch } from "./state.js"
import { refreshProjects } from "./views/projects.js"

const root = document.getElementById("root")
if (!root) throw new Error("elemento #root não encontrado")

// recupera as configurações salvas
void chrome.storage.local.get(["griver.serverUrl", "griver.token"]).then((stored) => {
  if (stored["griver.serverUrl"]) state.serverUrl = stored["griver.serverUrl"] as string
  if (stored["griver.token"]) state.token = stored["griver.token"] as string
  patch({})
})

// status inicial (o service worker garante o token antes de responder)
void chrome.runtime
  .sendMessage({ type: "panel:status" })
  .then((response) => {
    const status = response as { status?: string; token?: string }
    if (status?.status) patch({ status: status.status as never })
    if (status?.token && !state.token) patch({ token: status.token })
    // sempre carregar projetos ao abrir o painel, para que projetos gravados
    // sejam carregados automaticamente
    void refreshProjects()

    // Verificar se o servidor está respondendo
    verificarServidorConectado()
  })
  .catch(() => undefined)

/**
 * Verifica se o servidor está respondendo.
 * Se não estiver, exibe um aviso impedindo o uso do painel.
 */
async function verificarServidorConectado(): Promise<void> {
  try {
    const url = state.serverUrl || "http://127.0.0.1:7331"
    const response = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
      method: "GET",
      timeout: 3000,
    })

    if (!response.ok) {
      throw new Error("Servidor não respondeu corretamente")
    }

    // Servidor ok - esconder qualquer aviso prévio
    patch({ notice: undefined })
  } catch (error) {
    // Servidor inacessível - mostrar aviso
    const mensagem = error instanceof Error ? error.message : "Erro ao conectar com o servidor"
    setNotice(mensagem, "error")

    // Adicionar classe de overlay no root para bloquear interação
    if (root) {
      root.style.position = "relative"
      root.style.overflow = "hidden"
      // Criar overlay
      const overlay = document.createElement("div")
      overlay.style.position = "absolute"
      overlay.style.top = "0"
      overlay.style.left = "0"
      overlay.style.width = "100%"
      overlay.style.height = "100%"
      overlay.style.background = "rgba(20, 22, 26, 0.95)"
      overlay.style.zIndex = "1000"
      overlay.style.display = "flex"
      overlay.style.flexDirection = "column"
      overlay.style.alignItems = "center"
      overlay.style.justifyContent = "center"
      overlay.style.color = "#e6e9ef"
      overlay.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

      // Mensagem de erro
      const msg = document.createElement("div")
      msg.style.textAlign = "center"
      msg.style.maxWidth = "90%"
      msg.style.padding = "20px"
      msg.style.background = "rgba(242, 85, 90, 0.15)"
      msg.style.border = "1px solid #f2555a"
      msg.style.borderRadius = "8px"
      msg.style.backdropFilter = "blur(10px)"
      msg.innerHTML = `
        <h3 style="margin: 0 0 10px 0; color: #f2555a;">⚠️ Servidor não disponível</h3>
        <p style="margin: 0 0 15px 0; color: #98a1b0;">Não foi possível conectar ao servidor Griver em ${url}</p>
        <p style="margin: 0; color: #98a1b0; font-size: 12px;">Verifique se o servidor está rodando e tente novamente.</p>
        <button id="btn-retry" style="
          margin-top: 15px;
          padding: 8px 16px;
          background: #f2555a;
          color: #0d1017;
          border: none;
          border-radius: 4px;
          font-size: 13px;
          cursor: pointer;
        ">Tentar novamente</button>
      `

      // Botão de retry
      const btnRetry = msg.querySelector("#btn-retry")
      btnRetry?.addEventListener("click", async () => {
        overlay.remove()
        root!.removeChild(overlay)
        // Tentar conectar novamente
        try {
          const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
            method: "GET",
            timeout: 3000,
          })
          if (res.ok) {
            patch({ notice: undefined })
            // Recarregar projetos
            void refreshProjects()
          }
        } catch (e) {
          setNotice("Servidor ainda não disponível", "error")
        }
      })

      root.appendChild(overlay)
      overlay.appendChild(msg)
    }
  }
}

mount(root)