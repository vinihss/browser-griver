import type { RecordedEvent, Recipe } from "@griver/core"
import { INTERNAL, type OverlayAction } from "../shared/constants.js"

/**
 * Overlay de gravação desenhado dentro da página.
 *
 * Fica num Shadow DOM para que o CSS do site não afete o widget — nem o
 * widget afete o site. Todo comando sai por `chrome.runtime.sendMessage` e
 * chega ao service worker, que é o dono do estado da gravação.
 */

export interface OverlayState {
  /** o overlay deve estar visível */
  visible: boolean
  /** a captura está ativa */
  recording: boolean
  /** a captura está pausada */
  paused: boolean
  /** quantidade de passos capturados */
  steps: number
  /** eventos capturados enquanto grava */
  events: RecordedEvent[]
  /** receita pronta (após parar) */
  recipe?: Recipe
  /** o servidor confirmou a gravação e a receita pode ser salva */
  confirmed: boolean
}

const EMPTY: OverlayState = {
  visible: false,
  recording: false,
  paused: false,
  steps: 0,
  events: [],
  recipe: undefined,
  confirmed: false,
}

export class RecordingOverlay {
  private host: HTMLDivElement | undefined
  private shadow: ShadowRoot | undefined
  private state: OverlayState = EMPTY

  /**
   * Prepara o overlay e pergunta ao service worker o que exibir.
   *
   * Devolve o estado para o content script decidir se precisa retomar a
   * captura — é o que faz a gravação sobreviver a uma navegação.
   */
  async mount(): Promise<OverlayState> {
    this.ensureHost()
    try {
      const answer = (await chrome.runtime.sendMessage({ type: INTERNAL.overlayQuery })) as
        | OverlayState
        | undefined
      const state = answer ?? EMPTY
      this.render(state)
      return state
    } catch {
      // o service worker ainda não respondeu: o overlay fica escondido
      return EMPTY
    }
  }

  /** Redesenha o overlay com o estado recebido. */
  render(state: OverlayState): void {
    this.state = state
    if (!state.visible) {
      this.host?.remove()
      this.host = undefined
      this.shadow = undefined
      return
    }
    this.ensureHost()
    this.paint()
  }

  /** Remove o overlay da página. */
  destroy(): void {
    this.host?.remove()
    this.host = undefined
    this.shadow = undefined
  }

  // ── construção ───────────────────────────────────────────────────────────

  private ensureHost(): void {
    if (this.host?.isConnected) return

    const host = document.createElement("div")
    host.setAttribute("data-griver-overlay", "")
    host.style.cssText = "all: initial; position: static;"

    const shadow = host.attachShadow({ mode: "open" })
    shadow.appendChild(styleElement())
    shadow.appendChild(this.build())

    ;(document.documentElement || document.body).appendChild(host)

    this.host = host
    this.shadow = shadow
  }

  private build(): HTMLElement {
    const root = document.createElement("div")
    root.className = "griver-root"

    // ── barra superior: Record/Pause · Stop · Cancel/Confirm ──
    const bar = document.createElement("div")
    bar.className = "griver-bar"

    bar.appendChild(
      this.iconButton("⏺", "Record", () => {
        if (!this.state.recording) void this.send("start")
        else if (this.state.paused) void this.send("resume")
        else void this.send("pause")
      }),
    )
    bar.appendChild(this.iconButton("⏸", "Pause", () => void this.send("pause")))
    bar.appendChild(this.iconButton("⏹", "Stop", () => void this.send("stop")))

    const spacer = document.createElement("div")
    spacer.className = "griver-spacer"
    bar.appendChild(spacer)

    bar.appendChild(this.textButton("Cancel", () => void this.send("cancel")))
    bar.appendChild(this.textButton("Confirm", () => void this.send("confirm")))

    root.appendChild(bar)

    // ── painel de passos ──
    const panel = document.createElement("div")
    panel.className = "griver-panel"

    const head = document.createElement("div")
    head.className = "griver-panel-head"
    const title = document.createElement("span")
    title.className = "griver-panel-title"
    title.textContent = "Steps"
    head.appendChild(title)

    const edit = document.createElement("button")
    edit.className = "griver-icon-btn"
    edit.textContent = "✎"
    edit.title = "Editar"
    edit.setAttribute("aria-label", "Editar")
    edit.addEventListener("click", (event) => {
      event.stopPropagation()
      void this.send("edit")
    })
    head.appendChild(edit)
    panel.appendChild(head)

    const list = document.createElement("div")
    list.className = "griver-steps"
    panel.appendChild(list)

    const footer = document.createElement("div")
    footer.className = "griver-panel-foot"
    const cancel = this.textButton("Cancel", () => void this.send("cancel"))
    const save = this.textButton("Save", () => void this.send("save"))
    save.classList.add("griver-primary")
    footer.appendChild(cancel)
    footer.appendChild(save)
    panel.appendChild(footer)

    root.appendChild(panel)

    return root
  }

  // ── desenho ──────────────────────────────────────────────────────────────

  private paint(): void {
    const shadow = this.shadow
    if (!shadow) return

    const list = shadow.querySelector(".griver-steps")
    if (list) {
      list.textContent = ""
      const rows = this.state.recipe
        ? this.state.recipe.steps.map(describeStep)
        : this.state.events.map(describeEvent)
      if (!rows.length) {
        const empty = document.createElement("div")
        empty.className = "griver-empty"
        empty.textContent = "Nenhum passo capturado ainda."
        list.appendChild(empty)
      }
      for (const row of rows) {
        const item = document.createElement("div")
        item.className = "griver-step"
        item.textContent = row
        list.appendChild(item)
      }
    }

    const bar = shadow.querySelector(".griver-bar")
    if (bar) {
      const buttons = Array.from(bar.querySelectorAll("button"))
      // [Record/Pause, Pause, Stop, spacer, Cancel, Confirm]
      const record = buttons[0]
      const pause = buttons[1]
      const stop = buttons[2]
      if (record) {
        record.textContent = this.state.recording && !this.state.paused ? "⏸" : "⏺"
        record.title = this.state.recording && !this.state.paused ? "Pause" : "Record"
      }
      if (pause) pause.style.display = "none"
      if (stop) stop.style.display = this.state.recording ? "" : "none"
    }
  }

  // ── controles ────────────────────────────────────────────────────────────

  private iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button")
    button.className = "griver-icon-btn"
    button.textContent = label
    button.title = title
    button.setAttribute("aria-label", title)
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      onClick()
    })
    return button
  }

  private textButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button")
    button.className = "griver-btn"
    button.textContent = label
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      onClick()
    })
    return button
  }

  private async send(action: OverlayAction): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: INTERNAL.overlayCommand, action })
    } catch {
      // o service worker pode estar dormindo: ele reidrata no próximo evento
    }
  }
}

/** Descreve um passo da receita para a lista do overlay. */
function describeStep(step: { type: string; target?: { selectors?: string[] }; url?: string; value?: string; key?: string }): string {
  const selector = step.target?.selectors?.[0] ?? ""
  switch (step.type) {
    case "navigate":
      return `navegar para ${step.url ?? ""}`
    case "click":
      return `clicar em ${selector}`
    case "fill":
      return `preencher ${selector} = ${step.value ?? ""}`
    case "select":
      return `selecionar ${selector} = ${step.value ?? ""}`
    case "press":
      return `pressionar ${step.key ?? ""}`
    case "wait":
      return `esperar`
    case "waitFor":
      return `aguardar ${selector}`
    case "extract":
      return `extrair ${selector}`
    case "assert":
      return `verificar ${selector}`
    default:
      return step.type
  }
}

/** Descreve um evento bruto de gravação. */
function describeEvent(event: RecordedEvent): string {
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

/** Estilos do overlay — ficam no shadow root, então não vazam para a página. */
function styleElement(): HTMLStyleElement {
  const style = document.createElement("style")
  style.textContent = `
    :host { all: initial; }
    .griver-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: #e6e9ef;
    }
    .griver-bar {
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border: 1px solid #2b303a;
      border-radius: 10px;
      background: rgba(27, 30, 36, 0.96);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
    }
    .griver-spacer { width: 8px; }
    .griver-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid #2b303a;
      border-radius: 6px;
      background: #22262e;
      color: #e6e9ef;
      font: inherit;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
    }
    .griver-icon-btn:hover { border-color: #6b8afd; }
    .griver-btn {
      padding: 5px 10px;
      border: 1px solid #2b303a;
      border-radius: 6px;
      background: #22262e;
      color: #e6e9ef;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .griver-btn:hover { border-color: #6b8afd; }
    .griver-primary { background: #6b8afd; border-color: #6b8afd; color: #0d1017; font-weight: 600; }
    .griver-panel {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 260px;
      max-height: calc(100vh - 24px);
      display: flex;
      flex-direction: column;
      border: 1px solid #2b303a;
      border-radius: 10px;
      background: rgba(27, 30, 36, 0.97);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      overflow: hidden;
      pointer-events: auto;
    }
    .griver-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid #2b303a;
    }
    .griver-panel-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #98a1b0;
    }
    .griver-steps {
      flex: 1;
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 60px;
    }
    .griver-step {
      padding: 5px 8px;
      border-radius: 6px;
      background: #22262e;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.45;
      word-break: break-word;
    }
    .griver-empty {
      padding: 10px;
      color: #98a1b0;
      font-size: 12px;
      text-align: center;
    }
    .griver-panel-foot {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid #2b303a;
    }
  `
  return style
}
