import { h, button, input } from "../dom.js"
import { state, patch, setNotice } from "../state.js"
import { createProject, deleteProject, loadProjects, loadRecipes } from "../api.js"
import { setActiveProject } from "../messaging.js"

/** Aba de projetos: listar, criar e remover. */
export function projectsView(): HTMLElement {
  const container = h("div", { class: "view" })

  const nameInput = input("", (value) => {
    nameInput.value = value
  }, { placeholder: "Nome do novo projeto" })

  const create = async () => {
    const name = nameInput.value.trim()
    if (!name) {
      setNotice("Dê um nome ao projeto.", "error")
      return
    }
    try {
      const project = await createProject(name)
      nameInput.value = ""
      await refreshProjects()
      patch({ selectedProjectId: project.id })
      setActiveProject(project.id)
      setNotice(`Projeto "${project.name}" criado.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }

  container.appendChild(
    h("div", { class: "row" }, nameInput, button("Criar", create, { variant: "primary" })),
  )

  const list = h("div", { class: "list" })
  container.appendChild(list)

  if (!state.projects.length) {
    list.appendChild(h("p", { class: "empty" }, "Nenhum projeto ainda. Crie o primeiro acima."))
  }

  for (const project of state.projects) {
    const isSelected = project.id === state.selectedProjectId
    const item = h(
      "div",
      { class: `list-item${isSelected ? " selected" : ""}` },
      h(
        "button",
        {
          class: "list-item-main",
          onclick: async () => {
            patch({ selectedProjectId: project.id, selectedRecipeId: "" })
            setActiveProject(project.id)
            // Navegar para a tela de receitas quando projeto é selecionado
            patch({ tab: "receitas" })
            try {
              const recipes = await loadRecipes(project.id)
              patch({ recipes })
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error), "error")
            }
          },
        },
        h("span", { class: "list-item-title" }, project.name),
        h("span", { class: "list-item-meta" }, `${project.recipeCount ?? 0} receita(s)`),
      ),
      button("Remover", async () => {
        try {
          await deleteProject(project.id)
          await refreshProjects()
          setNotice(`Projeto "${project.name}" removido.`)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error), "error")
        }
      }, { variant: "ghost" }),
    )
    list.appendChild(item)
  }

  return container
}

/** Aba de ajustes: servidor e token. */
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
          })) as { ok: boolean; status?: string }
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

/** Recarrega projetos e receitas do servidor. */
export async function refreshProjects(): Promise<void> {
  try {
    const projects = await loadProjects()
    const recipes = await loadRecipes(state.selectedProjectId || undefined)
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
