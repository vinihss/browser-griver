import type { RecordedEvent } from "@griver/core"
import { buildSelectorCandidates, visibleText } from "./selector.js"

/**
 * Grava as ações do usuário na página.
 *
 * Os eventos são capturados na fase `capture` para interceptar cliques antes
 * que a página os trate, mas sem impedir o comportamento normal.
 */
export class Recorder {
  private recording = false
  private paused = false
  private onEvent: ((event: RecordedEvent) => void) | undefined
  private readonly pendingInputs = new Map<Element, ReturnType<typeof setTimeout>>()
  /** último valor emitido por campo — evita o par `input` + `change` */
  private readonly emittedValues = new WeakMap<Element, string>()
  private readonly listeners: (() => void)[] = []

  get isRecording(): boolean {
    return this.recording && !this.paused
  }

  start(onEvent: (event: RecordedEvent) => void): void {
    if (this.recording) return
    this.recording = true
    this.paused = false
    this.onEvent = onEvent

    const onClick = (event: MouseEvent) => {
      if (!this.isRecording) return
      const element = event.target as Element | null
      if (!element || !(element instanceof Element)) return
      if (!isInteractivable(element)) return

      const candidates = buildSelectorCandidates(element)
      if (!candidates.length) return

      // o preenchimento pendente aconteceu antes deste clique
      this.flushPending()

      onEvent({
        kind: "click",
        url: location.href,
        selectors: candidates.map((candidate) => candidate.selector),
        text: visibleText(element),
        ts: Date.now(),
      })
    }

    const onChange = (event: Event) => {
      if (!this.isRecording) return
      const element = event.target as Element | null
      if (!(element instanceof Element)) return
      if (!isFillable(element)) return

      // `select` é uma ação separada: o que estava sendo digitado vem antes
      if (element instanceof HTMLSelectElement) {
        this.flushPending()
        this.emitChange(element, onEvent)
        return
      }

      // `change` encerra a digitação: emite já e cancela o adiamento
      this.cancelPending(element)
      this.emitChange(element, onEvent)
    }

    const onInput = (event: Event) => {
      if (!this.isRecording) return
      const element = event.target as Element | null
      if (!(element instanceof Element)) return
      if (!isFillable(element)) return

      // `select` é emitido pelo `change`, que traz o valor final
      if (element instanceof HTMLSelectElement) return

      // agrupa digitação contínua no mesmo campo
      this.cancelPending(element)
      this.pendingInputs.set(
        element,
        setTimeout(() => {
          this.pendingInputs.delete(element)
          if (this.isRecording) this.emitChange(element, onEvent)
        }, 500),
      )
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!this.isRecording) return
      if (!["Enter", "Escape", "Tab"].includes(event.key)) return
      // Enter envia o formulário: o que foi digitado precisa vir antes
      this.flushPending()

      const element = event.target as Element | null
      const candidates =
        element instanceof Element ? buildSelectorCandidates(element).map((c) => c.selector) : undefined

      onEvent({
        kind: "keydown",
        url: location.href,
        key: event.key,
        selectors: candidates,
        ts: Date.now(),
      })
    }

    const onScroll = () => {
      if (!this.isRecording) return
      if (window.scrollY === 0) return
      onEvent({ kind: "scroll", url: location.href, ts: Date.now() })
    }

    document.addEventListener("click", onClick, true)
    document.addEventListener("change", onChange, true)
    document.addEventListener("input", onInput, true)
    document.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("scroll", onScroll, { passive: true })

    this.listeners.push(
      () => document.removeEventListener("click", onClick, true),
      () => document.removeEventListener("change", onChange, true),
      () => document.removeEventListener("input", onInput, true),
      () => document.removeEventListener("keydown", onKeyDown, true),
      () => window.removeEventListener("scroll", onScroll),
    )
  }

  /** Emite agora os preenchimentos adiados, mantendo a ordem dos passos. */
  private flushPending(): void {
    const emit = this.onEvent
    if (!emit) return
    for (const [element, timer] of [...this.pendingInputs]) {
      clearTimeout(timer)
      this.pendingInputs.delete(element)
      this.emitChange(element, emit)
    }
  }

  private cancelPending(element: Element): void {
    const timer = this.pendingInputs.get(element)
    if (!timer) return
    clearTimeout(timer)
    this.pendingInputs.delete(element)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  /**
   * Encerra a gravação e devolve os eventos que estavam adiados.
   *
   * Eles são entregues na resposta do comando para chegarem ao servidor
   * antes do `record.stop` — senão o último campo digitado se perderia.
   */
  stop(): RecordedEvent[] {
    const restantes: RecordedEvent[] = []
    const emit = this.onEvent
    if (emit) {
      for (const [element, timer] of [...this.pendingInputs]) {
        clearTimeout(timer)
        this.pendingInputs.delete(element)
        this.emitChange(element, (event) => restantes.push(event))
      }
    }

    this.recording = false
    this.paused = false
    this.onEvent = undefined
    for (const remove of this.listeners) remove()
    this.listeners.length = 0
    for (const timer of this.pendingInputs.values()) clearTimeout(timer)
    this.pendingInputs.clear()
    return restantes
  }

  private emitChange(element: Element, onEvent: (event: RecordedEvent) => void): void {
    const candidates = buildSelectorCandidates(element)
    if (!candidates.length) return

    const isPassword =
      element instanceof HTMLInputElement && element.type === "password"
    const value = isPassword
      ? "{{secret}}"
      : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element instanceof HTMLSelectElement
          ? element.value
          : ""

    // `input` e `change` disparam juntos: o mesmo valor no mesmo campo vira
    // um único passo
    if (this.emittedValues.get(element) === value) return
    this.emittedValues.set(element, value)

    onEvent({
      kind: element instanceof HTMLSelectElement ? "select" : "input",
      url: location.href,
      selectors: candidates.map((candidate) => candidate.selector),
      value,
      text: visibleText(element),
      ts: Date.now(),
    })
  }
}

/** Elementos que valem a pena registrar como clique. */
function isInteractivable(element: Element): boolean {
  const tag = element.tagName
  if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || tag === "LABEL") return true
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type
    return !["text", "password", "email", "number", "search", "tel", "url", "date"].includes(type)
  }
  if (element.getAttribute("role") === "button") return true
  if (element.hasAttribute("onclick")) return true
  return false
}

/** Elementos cujo valor pode ser preenchido. */
function isFillable(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLSelectElement) return true
  if (element instanceof HTMLInputElement) {
    return !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(element.type)
  }
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return false
}
