type Child = Node | string | number | null | undefined | false

type Props = Record<string, unknown> & {
  class?: string
  onclick?: (event: MouseEvent) => void
  oninput?: (event: Event) => void
  onchange?: (event: Event) => void
  onkeydown?: (event: KeyboardEvent) => void
}

/** Cria um elemento com atributos, eventos e filhos. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === "class") {
      element.className = String(value)
    } else if (key === "text") {
      element.textContent = String(value)
    } else if (key === "html") {
      element.innerHTML = String(value)
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2), value as EventListener)
    } else if (key === "value" && element instanceof HTMLInputElement) {
      element.value = String(value)
    } else if (key === "value" && element instanceof HTMLTextAreaElement) {
      element.value = String(value)
    } else if (key === "checked" && element instanceof HTMLInputElement) {
      element.checked = Boolean(value)
    } else {
      element.setAttribute(key, String(value))
    }
  }

  append(element, children)
  return element
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)))
  }
}

/** Remove todos os filhos de um elemento. */
export function clear(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild)
}

/** Botão com variantes visuais. */
export function button(
  label: string,
  onClick: () => void,
  options: { variant?: "primary" | "danger" | "ghost" | "subtle"; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const element = h(
    "button",
    {
      class: `btn btn-${options.variant ?? "subtle"}`,
      onclick: () => onClick(),
      ...(options.disabled ? { disabled: "disabled" } : {}),
      ...(options.title ? { title: options.title } : {}),
    },
    label,
  )
  return element
}

/** Campo de texto rotulado. */
export function input(
  value: string,
  onInput: (value: string) => void,
  options: { placeholder?: string; type?: string; id?: string } = {},
): HTMLInputElement {
  return h("input", {
    class: "input",
    value,
    type: options.type ?? "text",
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    ...(options.id ? { id: options.id } : {}),
    oninput: (event: Event) => onInput((event.target as HTMLInputElement).value),
  })
}

/** Área de texto multilinha. */
export function textarea(
  value: string,
  onInput: (value: string) => void,
  options: { placeholder?: string; rows?: number; class?: string } = {},
): HTMLTextAreaElement {
  return h("textarea", {
    class: options.class ?? "textarea",
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    rows: options.rows ?? 6,
    oninput: (event: Event) => onInput((event.target as HTMLTextAreaElement).value),
  })
}

/** Etiqueta colorida para o alvo de uma receita. */
export function targetBadge(target: string): HTMLElement {
  return h("span", { class: `badge badge-${target}` }, target === "browser" ? "browser" : "os")
}
