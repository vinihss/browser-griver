import { buildRegExp, type Expect, type ExtractAttr, type TargetRef } from "@griver/core"

/**
 * Execução de passos dentro da aba.
 *
 * Cada operação é serializável (entra e sai como JSON) porque o service
 * worker as invoca por `chrome.tabs.sendMessage`.
 */

export interface ResolvedTarget {
  element: Element
  /** seletores tentados, na ordem */
  tried: string[]
}

export class PageError extends Error {
  constructor(message: string, readonly tried?: string[]) {
    super(message)
    this.name = "PageError"
  }
}

/** Resolve um alvo testando os candidatos em ordem. */
export function resolveTarget(target: TargetRef, options: { requireMatch?: boolean } = {}): ResolvedTarget {
  const requireMatch = options.requireMatch ?? true
  const tried: string[] = []

  for (const selector of target.selectors) {
    tried.push(selector)
    let found: Element | undefined
    try {
      found = document.querySelector(selector) ?? undefined
    } catch {
      found = undefined
    }
    if (!found) continue
    if (target.nth !== undefined) {
      const all = document.querySelectorAll(selector)
      found = all[target.nth] ?? found
    }
    if (!requireMatch) return { element: found, tried }
    if (isVisible(found)) return { element: found, tried }
  }

  if (target.text) {
    tried.push(`text="${target.text}"`)
    const byText = findByText(target.text)
    if (byText) return { element: byText, tried }
  }

  throw new PageError(
    `nenhum seletor casou com o elemento (tentados: ${tried.join(", ")})`,
    tried,
  )
}

function findByText(text: string): Element | undefined {
  const walker = document.createTreeWalker(document.body ?? document, NodeFilter.SHOW_ELEMENT)
  let node = walker.currentNode as Element | null
  while (node) {
    if ((node.textContent ?? "").trim() === text.trim() && node.children.length === 0) return node
    node = walker.nextNode() as Element | null
  }
  return undefined
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true
  const style = window.getComputedStyle(element)
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
  return element.offsetParent !== null || element.getClientRects().length > 0
}

export function click(target: TargetRef, options: { clickCount?: number; force?: boolean } = {}): void {
  const { element } = resolveTarget(target)
  const count = options.clickCount ?? 1

  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior })
  }

  const rect = (element as HTMLElement).getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2

  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
  }

  for (let index = 0; index < count; index++) {
    element.dispatchEvent(new PointerEvent("pointerdown", common))
    element.dispatchEvent(new MouseEvent("mousedown", common))
    if (element instanceof HTMLElement) element.focus()
    element.dispatchEvent(new PointerEvent("pointerup", common))
    element.dispatchEvent(new MouseEvent("mouseup", common))
    element.dispatchEvent(new MouseEvent("click", common))
  }

  // alguns controles só respondem ao método nativo
  if (element instanceof HTMLElement && element.tagName === "BUTTON") {
    element.click()
  }
}

export function fill(target: TargetRef, value: string): void {
  const { element } = resolveTarget(target)

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeValue(element, value)
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = value
  } else {
    throw new PageError("elemento não aceita digitação")
  }

  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
}

/** Define o valor ignorando o cache interno do React/Vue. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  if (setter) setter.call(element, value)
  else element.value = value
}

export function press(target: TargetRef | undefined, key: string): void {
  const element = target ? resolveTarget(target).element : document.activeElement ?? document.body
  const init = { key, code: key, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit
  element.dispatchEvent(new KeyboardEvent("keydown", init))
  element.dispatchEvent(new KeyboardEvent("keypress", init))
  element.dispatchEvent(new KeyboardEvent("keyup", init))

  // ENTER em um formulário costuma disparar o envio
  if (key === "Enter" && element instanceof HTMLInputElement && element.form) {
    element.form.requestSubmit?.()
  }
}

export function select(target: TargetRef, value: string): void {
  const { element } = resolveTarget(target)
  if (!(element instanceof HTMLSelectElement)) {
    throw new PageError("elemento não é um <select>")
  }
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
}

export function hover(target: TargetRef): void {
  const { element } = resolveTarget(target)
  element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }))
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }))
  element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, composed: true }))
  element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, composed: true }))
}

export function scrollTo(target: TargetRef | undefined, position?: "top" | "bottom" | "center"): void {
  if (!target) {
    if (position === "top") window.scrollTo({ top: 0 })
    else if (position === "center") window.scrollTo({ top: document.body.scrollHeight / 2 })
    else window.scrollTo({ top: document.body.scrollHeight })
    return
  }
  const { element } = resolveTarget(target)
  element.scrollIntoView({ block: position === "top" ? "start" : position === "center" ? "center" : "end" })
}

export function upload(target: TargetRef, files: string[]): void {
  const { element } = resolveTarget(target)
  if (!(element instanceof HTMLInputElement) || element.type !== "file") {
    throw new PageError("elemento não é um input de arquivo")
  }
  // O navegador não permite preencher inputs de arquivo por script.
  throw new PageError(
    `envio de arquivo precisa do modo avançado (chrome.debugger); arquivos: ${files.join(", ")}`,
  )
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(
  target: TargetRef,
  state: "visible" | "hidden" | "attached" = "visible",
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    let element: Element | undefined
    try {
      element = resolveTarget(target, { requireMatch: false }).element
    } catch {
      element = undefined
    }
    if (element) {
      const visible = isVisible(element)
      if (state === "attached") return
      if (state === "visible" && visible) return
      if (state === "hidden" && !visible) return
    }
    await wait(100)
  }
  throw new PageError(`elemento não ficou "${state}" em ${timeout}ms`)
}

export function extract(
  target: TargetRef,
  attr: ExtractAttr | undefined,
  many: boolean,
): { value: unknown; count: number } {
  if (many) {
    // os candidatos são alternativas: o primeiro que casa traz a lista
    // inteira. Usar só o primeiro seletor perdia a lista quando o site
    // mudava a classe e o segundo candidate era o que casava.
    for (const selector of target.selectors) {
      let elements: Element[] = []
      try {
        elements = Array.from(document.querySelectorAll(selector))
      } catch {
        continue
      }
      if (elements.length === 0) continue
      const values = elements.map((element) => readValue(element, attr))
      return { value: values, count: values.length }
    }
    return { value: [], count: 0 }
  }
  const { element } = resolveTarget(target)
  return { value: readValue(element, attr), count: 1 }
}

function readValue(element: Element, attr: ExtractAttr | undefined): unknown {
  switch (attr) {
    case "html":
      return element.innerHTML
    case "href":
      return element.getAttribute("href")
    case "value":
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.getAttribute("value")
    case "src":
      return element.getAttribute("src")
    case "count":
      return 1
    default:
      return (element.textContent ?? "").trim()
  }
}

export function assert(target: TargetRef | undefined, expect: Expect, scope: Record<string, unknown>): void {
  if (!target) {
    if (expect.kind === "equals") {
      const actual = String(scope[expect.value ?? ""] ?? "")
      if (actual !== "") throw new PageError(`verificação falhou: esperado "${expect.value}"`)
    }
    return
  }

  const element = (() => {
    try {
      return resolveTarget(target, { requireMatch: false }).element
    } catch {
      return undefined
    }
  })()

  switch (expect.kind) {
    case "visible":
      if (!element || !isVisible(element)) throw new PageError("verificação falhou: elemento não está visível")
      return
    case "hidden":
      if (element && isVisible(element)) throw new PageError("verificação falhou: elemento ainda está visível")
      return
    case "exists":
      if (!element) throw new PageError("verificação falhou: elemento não existe")
      return
    case "text":
    case "equals": {
      const text = (element?.textContent ?? "").trim()
      if (text !== (expect.value ?? "")) {
        throw new PageError(`verificação falhou: "${text}" ≠ "${expect.value ?? ""}"`)
      }
      return
    }
    case "contains": {
      const text = (element?.textContent ?? "").trim()
      if (!text.includes(expect.value ?? "")) {
        throw new PageError(`verificação falhou: "${expect.value ?? ""}" não encontrado em "${text}"`)
      }
      return
    }
    case "matches": {
      const text = (element?.textContent ?? "").trim()
      const regex = buildRegExp(expect.value ?? "")
      if (!regex) {
        throw new PageError(`verificação falhou: expressão regular inválida "${expect.value ?? ""}"`)
      }
      if (!regex.test(text)) {
        throw new PageError(`verificação falhou: "${expect.value ?? ""}" não casa com "${text}"`)
      }
      return
    }
  }
}

export function evaluate(code: string): unknown {
  // `new Function` evita o eval direto (bloqueado por CSP em várias páginas)
  try {
    const runner = new Function(`return (${code})`) as () => unknown
    return runner()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Só redireciona quando a falha foi a CSP; erro do próprio código do
    // usuário deve chegar intacto (e não deve rodar duas vezes).
    if (!/Content Security Policy|unsafe-eval/i.test(message)) throw error
    // A CSP da extensão (MV3) proíbe `unsafe-eval`, então `new Function`
    // falha. Como fallback, o código é injetado no mundo da página: aí vale
    // a CSP do site, que normalmente permite script inline.
    return evaluateInPage(code)
  }
}

/** Executa o código no mundo da página e devolve o valor serializado. */
function evaluateInPage(code: string): unknown {
  const marker = `griver_eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const safe = code.replace(/<\/script/gi, "<\\/script")
  const script = document.createElement("script")
  script.textContent = `(function(){
    var out = document.createElement("div");
    out.id = ${JSON.stringify(marker)};
    try {
      var value = (function(){ return (${safe}) })();
      out.setAttribute("data-value", JSON.stringify(value === undefined ? null : value));
    } catch (error) {
      out.setAttribute("data-error", String(error && error.message ? error.message : error));
    }
    (document.documentElement || document.body).appendChild(out);
  })();`
  const root = document.documentElement ?? document.body
  if (!root) throw new PageError("página sem documento para injetar o script")
  root.appendChild(script)
  script.remove()

  const holder = document.getElementById(marker)
  if (!holder) {
    throw new PageError("a página bloqueou a execução de script (CSP) e o passo não pôde ser concluído")
  }
  const failure = holder.getAttribute("data-error")
  const value = holder.getAttribute("data-value")
  holder.remove()
  if (failure) throw new PageError(failure)
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function currentUrl(): string {
  return location.href
}
