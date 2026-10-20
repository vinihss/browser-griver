import { h, button } from "../dom.js"
import { state, patch, setNotice } from "../state.js"
import { sendToServer } from "../messaging.js"

export function chatView(): HTMLElement {
  const container = h("div", { class: "view view-chat" })

  const messages = h("div", { class: "chat-messages" })

  if (!state.chatMessages.length) {
    messages.appendChild(
      h(
        "p",
        { class: "empty" },
        "Converse com o assistente para editar a receita ou pedir ideias de automação.",
      ),
    )
  }

  for (const message of state.chatMessages) {
    const bubble = h(
      "div",
      { class: `chat-msg chat-${message.role}` },
      message.role === "assistant" ? h("div", { class: "chat-role" }, "assistente") : null,
      message.role === "system" ? h("div", { class: "chat-role" }, "sistema") : null,
      h("div", { class: "chat-text" }, message.text),
    )
    messages.appendChild(bubble)
  }

  for (const tool of state.chatTools) {
    messages.appendChild(
      h(
        "div",
        { class: `chat-tool tool-${tool.state}` },
        h("span", { class: "tool-name" }, tool.name),
        h("span", { class: "tool-state" }, tool.state),
      ),
    )
  }

  if (state.chatPermission) {
    const permission = state.chatPermission
    messages.appendChild(
      h(
        "div",
        { class: "chat-permission" },
        h("div", { class: "permission-title" }, "O assistente quer executar uma ação"),
        h("div", { class: "permission-action" }, permission.action),
        ...permission.resources.map((resource) => h("code", { class: "permission-resource" }, resource)),
        h(
          "div",
          { class: "row" },
          button(
            "Permitir",
            () => {
              sendToServer({
                type: "permission.reply",
                sessionId: state.chatSessionId,
                requestId: permission.requestId,
                reply: "once",
              })
              patch({ chatPermission: undefined })
            },
            { variant: "primary" },
          ),
          button(
            "Negar",
            () => {
              sendToServer({
                type: "permission.reply",
                sessionId: state.chatSessionId,
                requestId: permission.requestId,
                reply: "reject",
                feedback: "usuário recusou a ação",
              })
              patch({ chatPermission: undefined })
            },
            { variant: "danger" },
          ),
        ),
      ),
    )
  }

  container.appendChild(messages)

  const inputElement = h("textarea", {
    class: "textarea chat-input",
    placeholder: "Peça uma alteração no script…",
    rows: 3,
    oninput: (event: Event) => {
      state.chatDraft = (event.target as HTMLTextAreaElement).value
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        submit()
      }
    },
  }) as HTMLTextAreaElement

  if (inputElement.value !== state.chatDraft) inputElement.value = state.chatDraft

  function submit(): void {
    const text = state.chatDraft.trim()
    if (!text) return
    if (!state.chatSessionId) {
      // guarda o texto: a primeira mensagem abre a sessão e não pode se perder
      patch({ chatPending: text, chatDraft: "" })
      inputElement.value = ""
      sendToServer({ type: "chat.create", projectId: state.selectedProjectId || undefined })
      setNotice("Abrindo conversa…")
      return
    }
    // o servidor devolve a mensagem para todos os clientes; não ecoamos aqui
    sendToServer({ type: "chat.send", sessionId: state.chatSessionId, text })
    state.chatDraft = ""
    inputElement.value = ""
    patch({})
  }

  container.appendChild(
    h(
      "div",
      { class: "row chat-actions" },
      button("Enviar", submit, { variant: "primary" }),
      button(
        "Nova conversa",
        () => {
          sendToServer({ type: "chat.create", projectId: state.selectedProjectId || undefined })
          patch({
            chatSessionId: "",
            chatMessages: [],
            chatTools: [],
            chatPermission: undefined,
            chatPending: "",
          })
        },
        { variant: "ghost" },
      ),
    ),
  )
  container.appendChild(inputElement)

  return container
}
