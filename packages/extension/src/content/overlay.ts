import { INTERNAL, type OverlayAction } from "../shared/constants.js"

/**
 * Barra de controle da gravação, desenhada dentro da página.
 *
 * É só uma barra: os passos capturados não ficam mais aqui. Quando a
 * gravação termina, a barra some e a receita vai para a tela de edição do
 * painel — nada fica preso na página. Todo comando sai por
 * `chrome.runtime.sendMessage` e chega ao service worker, que é o dono do
 * estado da gravação.
 *
 * Fica num Shadow DOM para que o CSS do site não afete o widget — nem o
 * widget afete o site.
 */

export interface OverlayState {
  /** o overlay deve estar visível */
  visible: boolean
  /** a captura está ativa */
  recording: boolean
  /** a captura está pausada */
  paused: boolean
}

const EMPTY: OverlayState = {
  visible: false,
  recording: false,
  paused: false,
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

    // ── barra: Record/Pause · Stop · Cancel ──
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

    root.appendChild(bar)

    return root
  }

  // ── desenho ──────────────────────────────────────────────────────────────

  private paint(): void {
    const shadow = this.shadow
    if (!shadow) return

    const bar = shadow.querySelector(".griver-bar")
    if (!bar) return
    const buttons = Array.from(bar.querySelectorAll("button"))
    // [Record/Pause, Pause, Stop, spacer, Cancel]
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
  `
  return style
}
