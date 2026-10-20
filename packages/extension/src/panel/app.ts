import { h, button, clear } from "./dom.js"
import { state, patch, subscribe, setNotice, type TabId } from "./state.js"
import { loadRecipes } from "./api.js"
import { projectsView, refreshProjects, settingsView } from "./views/projects.js"
import { recipesView } from "./views/recipes.js"
import { recorderView } from "./views/recorder.js"
import { chatView } from "./views/chat.js"
import { sendToServer } from "./messaging.js"
import type { RecordedEvent, ServerMessage } from "@griver/core"

const TABS: { id: TabId; label: string }[] = [
  { id: "projetos", label: "Projetos" },
  { id: "gravador", label: "Gravar" },
  { id: "chat", label: "Chat" },
  { id: "ajustes", label: "Ajustes" },
]

let root: HTMLElement

export function mount(container: HTMLElement): void {
  root = container
  subscribe(render)
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  render()
}

function render(): void {
  if (!root) return

  const scrollTop = root.querySelector(".chat-messages")?.scrollTop ?? 0
  clear(root)

  root.appendChild(header())

  root.appendChild(tabBar())

  const body = h("div", { class: "body" })
  // Mostra receitas quando um projeto está selecionado (não usa aba 'receitas' na tabBar)
  if (state.selectedProjectId) {
    body.appendChild(recipesView())
  } else if (state.tab === "projetos") {
    body.appendChild(projectsView())
  } else if (state.tab === "gravador") {
    body.appendChild(recorderView())
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

function header(): HTMLElement {
  const statusLabel =
    state.status === "online"
      ? "conectado"
      : state.status === "connecting"
        ? "conectando…"
        : "desconectado"

  return h(
    "header",
    { class: "header" },
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-mark" }, "◆"),
      h("span", { class: "brand-name" }, "Griver"),
    ),
    h(
      "div",
      { class: `status status-${state.status}` },
      h("span", { class: "dot" }),
      statusLabel,
    ),
  )
}

function tabBar(): HTMLElement {
  const bar = h("nav", { class: "tabs" })
  for (const tab of TABS) {
    bar.appendChild(
      h(
        "button",
        {
          class: `tab${state.tab === tab.id ? " active" : ""}`,
          onclick: () => {
            patch({ tab: tab.id })
            if (tab.id === "projetos") void refreshProjects()
          },
        },
        tab.label,
      ),
    )
  }
  return bar
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
      void loadRecipes(state.selectedProjectId || undefined).then((recipes) => patch({ recipes }))
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
      patch({
        recordingEvents: [...state.recordingEvents, message.event as RecordedEvent].slice(-200),
      })
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
      // guarda a receita gerada para o botão "Salvar como receita"
      patch({
        recordedRecipe: message.recipe,
        recordingEvents: [],
      })
      setNotice(
        message.recipe?.steps.length
          ? `Gravação concluída: ${message.recipe.steps.length} passos prontos para salvar.`
          : "Gravação concluída, mas nenhum passo foi capturado.",
        message.recipe?.steps.length ? "info" : "error",
      )
      return
    }
    case "run.started": {
      patch({ runEvents: [], tab: "receitas" })
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

export { button }
