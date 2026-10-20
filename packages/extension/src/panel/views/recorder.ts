import { h, button } from "../dom.js"
import { state, patch, setNotice } from "../state.js"
import { recordCommand } from "../messaging.js"
import { createRecipeFromRecording } from "./recipes.js"

export function recorderView(): HTMLElement {
  const container = h("div", { class: "view" })

  const status = h(
    "div",
    { class: `record-status record-${state.recording.active ? (state.recording.paused ? "paused" : "on") : "off"}` },
    h("span", { class: "dot" }),
    state.recording.active
      ? state.recording.paused
        ? "Gravação pausada"
        : "Gravando…"
      : "Pronto para gravar",
    h("span", { class: "record-count" }, `${state.recording.steps} passos`),
  )
  container.appendChild(status)

  const controls = h("div", { class: "row wrap" })

  if (!state.recording.active) {
    controls.appendChild(
      button(
        "● Gravar",
        () => {
          recordCommand("start")
          setNotice("Gravação iniciada. Interaja com a página.")
        },
        { variant: "primary" },
      ),
    )
  } else {
    controls.appendChild(
      button(state.recording.paused ? "▶ Continuar" : "⏸ Pausar", () => {
        recordCommand(state.recording.paused ? "resume" : "pause")
      }),
    )
    controls.appendChild(
      button("■ Concluir", () => {
        recordCommand("stop")
        patch({ recordingEvents: [] })
        setNotice("Gravação concluída. Salve como receita para continuar.")
      }, { variant: "primary" }),
    )
    controls.appendChild(
      button("✕ Descartar", () => {
        recordCommand("discard")
        patch({ recording: { active: false, paused: false, steps: 0 }, recordingEvents: [] })
        setNotice("Gravação descartada.")
      }, { variant: "danger" }),
    )
  }

  container.appendChild(controls)

  const events = h("div", { class: "events" })
  if (!state.recordingEvents.length) {
    events.appendChild(
      h("p", { class: "empty" }, "Os passos capturados aparecem aqui em tempo real."),
    )
  }
  for (const event of state.recordingEvents.slice(-40).reverse()) {
    events.appendChild(
      h(
        "div",
        { class: "event" },
        h("span", { class: "event-kind" }, event.kind),
        h("span", { class: "event-detail" }, describeEvent(event)),
      ),
    )
  }
  container.appendChild(events)

  const nameInput = h("input", { class: "input", placeholder: "Nome da receita" }) as HTMLInputElement
  const targetSelect = h(
    "select",
    { class: "input" },
    h("option", { value: "browser" }, "browser (Playwright/Puppeteer)"),
    h("option", { value: "os" }, "os (Firecrawl)"),
  ) as HTMLSelectElement

  container.appendChild(
    h(
      "div",
      { class: "row wrap" },
      nameInput,
      targetSelect,
      button(
        "Salvar como receita",
        async () => {
          const name = nameInput.value.trim()
          if (!name) {
            setNotice("Dê um nome à receita.", "error")
            return
          }
          patch({ recipeTarget: targetSelect.value as "browser" | "os" })
          await createRecipeFromRecording(name)
          nameInput.value = ""
          const passos = state.recordedRecipe?.steps.length
          setNotice(
            passos ? `Receita "${name}" criada com ${passos} passos.` : `Receita "${name}" criada.`,
          )
        },
        { variant: "primary" },
      ),
    ),
  )

  container.appendChild(
    h(
      "p",
      { class: "hint" },
      state.recordedRecipe
        ? `Gravação pronta: ${state.recordedRecipe.steps.length} passos. Salve como receita para guardá-los.`
        : "Ao gravar, a extensão acompanha cliques, digitação, seleções e teclas. Senhas viram {{secret}}.",
    ),
  )

  return container
}

function describeEvent(event: {
  kind: string
  url?: string
  selectors?: string[]
  value?: string
  key?: string
}): string {
  const selector = event.selectors?.[0] ?? ""
  switch (event.kind) {
    case "click":
      return `clicar em ${selector}`
    case "input":
    case "change":
      return `preencher ${selector} = ${event.value ?? ""}`
    case "select":
      return `selecionar ${selector} = ${event.value ?? ""}`
    case "keydown":
      return `pressionar ${event.key ?? ""}`
    case "navigate":
      return `navegar para ${event.url ?? ""}`
    case "scroll":
      return "rolar a página"
    default:
      return event.kind
  }
}
