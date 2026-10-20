import { h, button, input } from "../dom.js"
import { state, patch, setNotice } from "../state.js"
import { loadProjects, loadRecipes } from "../api.js"
import { setActiveProject } from "../messaging.js"

/**
 * Aba de ajustes: servidor e token.
 */
export function settingsView(): HTMLElement {
  const container = h("div", { class: "view" })

  const urlInput = input(state.serverUrl, (value) => {
    state.serverUrl = value
  }, { placeholder: "http://127.0.0.1:7331" })

  const tokenInput = input(state.token, (value) => {
    state.token = value
  }, { placeholder: "token do servidor" })

  container.appendChild(
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Servidor"), urlInput),
  )
  container.appendChild(
    h(
      "label",
      { class: "field" },
      h("span", { class: "field-label" }, "Token (opcional)"),
      tokenInput,
    ),
  )

  container.appendChild(
    h(
      "div",
      { class: "row" },
      button(
        "Conectar",
        async () => {
          const response = (await chrome.runtime.sendMessage({
            type: "panel:connect",
            url: state.serverUrl,
            token: state.token,
          })) as { ok: boolean; status?: string; token?: string }
          // o token é do servidor conectado: trocar de servidor invalida o
          // que estava em memória, e as chamadas seguintes levariam 401
          if (response.token) patch({ token: response.token })
          patch({ status: (response.status ?? "connecting") as never })
          setNotice("Conectando…")
          if (response.status === "online") await refreshProjects()
        },
        { variant: "primary" },
      ),
      button(
        "Desconectar",
        async () => {
          await chrome.runtime.sendMessage({ type: "panel:disconnect" })
          patch({ status: "offline" })
        },
        { variant: "ghost" },
      ),
    ),
  )

  container.appendChild(
    h(
      "p",
      { class: "hint" },
      "O token é lido automaticamente do servidor local — em geral basta informar o endereço. " +
        "Ele autentica a extensão e protege as receitas contra páginas da web.",
    ),
  )

  return container
}

/**
 * Recarrega projetos e receitas do servidor.
 *
 * A lista de receitas é plana: o painel mostra todas, sem filtro de projeto.
 * O projeto ativo continua sendo o que a gravação usa.
 */
export async function refreshProjects(): Promise<void> {
  try {
    const projects = await loadProjects()
    const recipes = await loadRecipes()
    const selected = state.selectedProjectId || projects[0]?.id || ""
    patch({
      projects,
      recipes,
      selectedProjectId: selected,
    })
    // o service worker precisa saber o projeto ativo para a gravação
    if (selected) setActiveProject(selected)
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error), "error")
  }
}
