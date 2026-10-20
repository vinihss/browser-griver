/**
 * Geração de seletores para os elementos capturados pelo gravador.
 *
 * A ideia é guardar vários candidatos em ordem de preferência: o runtime tenta
 * cada um até um resolver, o que deixa a receita resistente a mudanças de
 * markup (ids dinâmicos, classes geradas, etc.).
 */

const TEST_ID_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]

export interface SelectorCandidate {
  selector: string
  /** o seletor resolve para exatamente um elemento no momento da captura */
  unique: boolean
  /** como o seletor foi obtido, útil para depurar */
  strategy: string
}

/** Monta a lista de candidatos de seletor para um elemento. */
export function buildSelectorCandidates(element: Element): SelectorCandidate[] {
  const candidates: SelectorCandidate[] = []
  const seen = new Set<string>()

  const push = (selector: string | undefined | null, strategy: string) => {
    if (!selector) return
    const trimmed = selector.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    candidates.push({ selector: trimmed, unique: isUnique(trimmed), strategy })
  }

  // 1. atributos de teste
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(attribute)
    if (value) push(`[${attribute}="${cssEscape(value)}"]`, attribute)
  }

  // 2. id
  const id = element.getAttribute("id")
  if (id && !/^\d/.test(id) && !id.includes(" ")) {
    push(`#${cssEscape(id)}`, "id")
  }

  // 3. name
  const name = element.getAttribute("name")
  if (name) push(`[name="${cssEscape(name)}"]`, "name")

  // 4. aria-label
  const ariaLabel = element.getAttribute("aria-label")
  if (ariaLabel) push(`[aria-label="${cssEscape(ariaLabel)}"]`, "aria-label")

  // 5. placeholder
  const placeholder = element.getAttribute("placeholder")
  if (placeholder) {
    push(`${element.tagName.toLowerCase()}[placeholder="${cssEscape(placeholder)}"]`, "placeholder")
  }

  // 6. label associado
  const labelText = associatedLabelText(element)
  if (labelText) push(`${element.tagName.toLowerCase()}[aria-label="${cssEscape(labelText)}"]`, "label")

  // 7. classes estáveis (sem classes geradas por hash)
  const stableClasses = stableClassesOf(element)
  if (stableClasses.length) {
    push(
      `${element.tagName.toLowerCase()}.${stableClasses.map(cssEscape).join(".")}`,
      "class",
    )
  }

  // 8. caminho CSS com nth-of-type
  const path = cssPath(element)
  if (path) push(path, "path")

  return candidates
}

/** Texto visível curto do elemento, usado como fallback. */
export function visibleText(element: Element, limit = 60): string | undefined {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
  if (!text || text.length > limit) return undefined
  return text
}

/** Classes que não parecem geradas dinamicamente. */
function stableClassesOf(element: Element): string[] {
  return Array.from(element.classList)
    .filter((name) => name.length > 0 && !/^(css|sc|jsx|emotion|_[a-zA-Z])/.test(name))
    .filter((name) => !/[0-9a-f]{6,}/i.test(name))
    .slice(0, 3)
}

function associatedLabelText(element: Element): string | undefined {
  const id = element.getAttribute("id")
  if (id) {
    const label = document.querySelector(`label[for="${cssEscape(id)}"]`)
    if (label?.textContent) return label.textContent.replace(/\s+/g, " ").trim().slice(0, 40)
  }
  const wrapping = element.closest("label")
  if (wrapping?.textContent) return wrapping.textContent.replace(/\s+/g, " ").trim().slice(0, 40)
  return undefined
}

/** Caminho CSS absoluto até o elemento. */
function cssPath(element: Element): string | undefined {
  const parts: string[] = []
  let current: Element | null = element

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
    let part = current.tagName.toLowerCase()

    if (current.id && !/^\d/.test(current.id)) {
      parts.unshift(`#${cssEscape(current.id)}`)
      break
    }

    const parent: Element | null = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current!.tagName,
      )
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
    }

    parts.unshift(part)
    current = parent
  }

  return parts.length ? parts.join(" > ") : undefined
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

/** Escapa um valor para uso dentro de um seletor CSS. */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}
