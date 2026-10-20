import { h, clear } from "./dom.js"
import { state, patch, subscribe, setNotice, type TabId } from "./state.js"
import { loadRecipes } from "./api.js"
import { refreshProjects, settingsView } from "./views/projects.js"
import { recipesView } from "./views/recipes.js"
import { chatView } from "./views/chat.js"
import { sendToServer } from "./messaging.js"
import type { Recipe, ServerMessage } from "@griver/core"

let root: HTMLElement

export function mount(container: HTMLElement): void {
  root = container
  subscribe(render)
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  // o painel se anuncia ao service worker: `chrome.runtime.sendMessage` do
  // worker não alcança outras páginas de extensão, então o caminho do
  // rascunho da gravação passa por esta conexão
  try {
    const port = chrome.runtime.connect({ name: "griver:panel" })
    port.onMessage.addListener((message) => {
      onRuntimeMessage(message as Record<string, unknown>)
    })
  } catch {
    // o service worker pode estar dormindo: a conexão abre sozinha depois
  }
  render()
}

function render(): void {
  if (!root) return

  const scrollTop = root.querySelector(".chat-messages")?.scrollTop ?? 0
  clear(root)

  root.appendChild(panelHeader())

  const body = h("div", { class: "body" })
  if (state.tab === "receitas") {
    body.appendChild(recipesView())
  } else if (state.tab === "chat") {
    body.appendChild(chatView())
  } else if (state.tab === "ajustes") {
    body.appendChild(settingsView())
  }
  root.appendChild(body)

  if (state.notice) {
    root.appendChild(
      h("div", { class: `notice notice-${state.notice.kind}` }, state.notice.text),
    )
  }

  const messages = root.querySelector(".chat-messages")
  if (messages) messages.scrollTop = scrollTop
}

/**
 * Cabeçalho do painel.
 *
 * À esquerda o `+` (novo script), à direita o estado da conexão e o toggle
 * entre Receitas e Chat.
 */
function panelHeader(): HTMLElement {
  const statusLabel =
    state.status === "online"
      ? "conectado"
      : state.status === "connecting"
        ? "conectando…"
        : "desconectado"

  return h(
    "header",
    { class: "panel-header" },
    h(
      "button",
      {
        class: "icon-btn",
        title: "Add New Script",
        "aria-label": "Add New Script",
        onclick: () => patch({ showAddScript: true, addScriptUrl: "" }),
      },
      "+",
    ),
    h(
      "div",
      { class: "panel-header-actions" },
      h(
        "button",
        {
          class: `icon-btn${state.tab === "receitas" ? " active" : ""}`,
          title: "Receitas",
          "aria-label": "Receitas",
          onclick: () => void goTo("receitas"),
        },
        "☰",
      ),
      h(
        "button",
        {
          class: `icon-btn${state.tab === "chat" ? " active" : ""}`,
          title: "Chat",
          "aria-label": "Chat",
          onclick: () => void goTo("chat"),
        },
        "✦",
      ),
      h(
        "button",
        {
          class: "icon-btn",
          title: "Ajustes",
          "aria-label": "Ajustes",
          onclick: () => void goTo("ajustes"),
        },
        "⚙",
      ),
      h(
        "div",
        { class: `status status-${state.status}`, title: statusLabel },
        h("span", { class: "dot" }),
        "Connection",
      ),
    ),
  )
}

/** Troca de tela recarregando o que a tela precisa. */
async function goTo(tab: TabId): Promise<void> {
  patch({ tab })
  if (tab === "receitas") {
    try {
      patch({ recipes: await loadRecipes() })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), "error")
    }
  }
}

// ── mensagens do service worker ─────────────────────────────────────────────

function onRuntimeMessage(message: Record<string, unknown>): void {
  if (message.type === "connection") {
    patch({ status: message.status as never })
    if (message.status === "online") void refreshProjects()
    return
  }

  if (message.type === "recording") {
    patch({
      recording: {
        active: Boolean(message.recording),
        paused: Boolean(message.paused),
        steps: Number(message.steps ?? 0),
      },
    })
    return
  }

  if (message.type === "server") {
    handleServerMessage(message.message as ServerMessage)
    return
  }

  if (message.type === "run-step") {
    const event = message.event as { path: string; type: string; status: string; error?: string }
    patch({
      runEvents: [...state.runEvents, event].slice(-100),
    })
    return
  }

  // o overlay pediu para abrir a receita gravada no editor do painel
  if (message.type === "panel:openEditor") {
    const recipe = message.recipe as Recipe | undefined
    if (!recipe) return
    patch({
      tab: "receitas",
      selectedRecipeId: "",
      draftRecipe: recipe,
      recipeText: JSON.stringify(recipe, null, 2),
      recipeDirty: true,
      recipeIssues: [],
    })
    return
  }

  // o overlay pediu para salvar: abre o modal já com a URL da gravação
  if (message.type === "panel:openAddScript") {
    const url = String(message.url ?? "")
    patch({
      tab: "receitas",
      showAddScript: true,
      addScriptUrl: url,
    })
    return
  }
}
function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "projects":
      patch({ projects: message.projects })
      return
    case "recipes":
      patch({ recipes: message.recipes })
      return
    case "projects.changed":
      void refreshProjects()
      return
    case "recipes.changed":
      void loadRecipes().then((recipes) => patch({ recipes }))
      return
    case "record.state":
      patch({
        recording: {
          active: message.state !== "idle",
          paused: message.state === "paused",
          steps: message.steps,
        },
      })
      return
    case "record.step":
      // a lista de passos vive no overlay, dentro da página
      return
    case "chat.sessions": {
      const current = message.sessions[0]
      if (!current || state.chatSessionId) return

      const pendente = state.chatPending
      if (pendente) {
        // a mensagem digitada antes de a sessão existir é enviada agora;
        // o servidor devolve o eco para todos os clientes
        patch({ chatSessionId: current.id, chatPending: "" })
        sendToServer({ type: "chat.send", sessionId: current.id, text: pendente })
      } else {
        patch({ chatSessionId: current.id })
      }
      return
    }
    case "chat.message": {
      const message_ = message.message
      if (message_.partial) {
        // streaming: concatena no buffer da mensagem
        const messages = [...state.chatMessages]
        const index = messages.findIndex((item) => item.id === message_.id)
        if (index >= 0) {
          messages[index] = { ...messages[index]!, text: messages[index]!.text + message_.text }
        } else {
          messages.push(message_)
        }
        patch({ chatMessages: messages })
        return
      }
      const messages = [...state.chatMessages]
      const index = messages.findIndex((item) => item.id === message_.id)
      if (index >= 0) {
        messages[index] = { ...messages[index]!, text: message_.text, partial: false }
      } else {
        messages.push(message_)
      }
      patch({ chatMessages: messages })
      return
    }
    case "chat.tool": {
      const tools = [...state.chatTools]
      const index = tools.findIndex((tool) => tool.name === message.toolName)
      if (index >= 0) {
        tools[index] = { ...tools[index]!, state: message.state, input: message.input ?? tools[index]!.input }
      } else {
        tools.push({ name: message.toolName, state: message.state, input: message.input })
      }
      patch({ chatTools: tools.slice(-12) })
      return
    }
    case "chat.permission":
      patch({
        chatPermission: {
          requestId: message.requestId,
          action: message.action,
          resources: message.resources,
          title: message.title,
        },
      })
      return
    case "record.finished": {
      // a receita pronta fica no overlay; o painel só avisa
      setNotice(
        message.recipe?.steps.length
          ? `Gravação concluída: ${message.recipe.steps.length} passos prontos para salvar.`
          : "Gravação concluída, mas nenhum passo foi capturado.",
        message.recipe?.steps.length ? "info" : "error",
      )
      return
    }
    case "run.started": {
      patch({ runEvents: [] })
      setNotice(`Execução iniciada: ${message.run.recipeName ?? message.run.id}`)
      return
    }
    case "run.finished": {
      const status = message.run.status
      if (status === "ok") setNotice("Execução concluída.")
      else if (status === "aborted") setNotice("Execução cancelada.")
      else setNotice(`Execução falhou: ${message.run.error ?? "erro desconhecido"}`, "error")
      return
    }
    case "error":
      setNotice(message.message, "error")
      return
  }
}
