import type { Driver, Expect, ExtractAttr, ScreenshotResult, TargetRef } from "@griver/core"
import { DriverError } from "@griver/core"

export interface FirecrawlDriverOptions {
  apiKey?: string
  apiBase?: string
  defaultTimeout?: number
  /** segunda o scrape quando as ações pendentes forem aplicadas */
  settleMs?: number
}

interface ScrapeResponse {
  success: boolean
  data?: {
    markdown?: string
    html?: string
    rawHtml?: string
    links?: string[]
    attributes?: { selector: string; attribute: string; values: string[] }[]
    screenshot?: string
    metadata?: { title?: string; url?: string; statusCode?: number }
  }
  error?: string
}

/**
 * Driver do alvo `os`: usa a API do Firecrawl em vez de um navegador.
 *
 * Interações viram `actions` do scrape e são aplicadas de uma vez; leituras
 * disparam um scrape extra com o `format` pedido.
 */
export async function createFirecrawlDriver(options: FirecrawlDriverOptions = {}): Promise<Driver> {
  const apiKey = options.apiKey
  const apiBase = (options.apiBase ?? "https://api.firecrawl.dev/v2").replace(/\/$/, "")
  const timeout = options.defaultTimeout ?? 60_000

  if (!apiKey) {
    throw new Error(
      "FIRECRAWL_API_KEY não configurada. Defina a variável de ambiente para usar o alvo os.",
    )
  }

  let currentUrl = ""
  let pendingActions: Record<string, unknown>[] = []
  let markdown = ""
  let html = ""

  const request = async (path: string, body: unknown): Promise<ScrapeResponse> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new DriverError(`resposta inválida do Firecrawl (HTTP ${response.status})`, {
          cause: text.slice(0, 400),
        })
      }
      if (!response.ok) {
        const message = (parsed as { error?: string }).error ?? `HTTP ${response.status}`
        throw new DriverError(`Firecrawl falhou: ${message}`, { cause: parsed })
      }
      return parsed as ScrapeResponse
    } finally {
      clearTimeout(timer)
    }
  }

  /** Executa um scrape aplicando as ações acumuladas e zera a fila. */
  const flush = async (formats: unknown[] = ["markdown", "html"]): Promise<ScrapeResponse> => {
    if (!currentUrl) throw new DriverError("nenhuma URL ativa — a receita precisa começar com navigate")
    const body: Record<string, unknown> = { url: currentUrl, formats, timeout }
    if (pendingActions.length > 0) {
      body.actions = pendingActions
      pendingActions = []
    }
    const response = await request("/scrape", body)
    if (!response.success) {
      throw new DriverError(`Firecrawl falhou: ${response.error ?? "erro desconhecido"}`)
    }
    markdown = response.data?.markdown ?? ""
    html = response.data?.html ?? response.data?.rawHtml ?? ""
    return response
  }

  const driver: Driver = {
    target: "os",

    async navigate(url: string) {
      currentUrl = url
      pendingActions = []
      await flush(["markdown", "html"])
    },

    async click(target: TargetRef) {
      pendingActions.push({ type: "click", selector: target.selectors[0] })
    },

    async fill(_target: TargetRef, value: string) {
      pendingActions.push({ type: "write", text: value })
    },

    async press(_target: TargetRef | undefined, key: string) {
      pendingActions.push({ type: "press", key })
    },

    async select() {
      throw new DriverError("o alvo os não suporta seleção em <select>")
    },

    async hover() {
      throw new DriverError("o alvo os não suporta hover")
    },

    async scrollTo() {
      throw new DriverError("o alvo os não suporta rolagem")
    },

    async upload() {
      throw new DriverError("o alvo os não suporta envio de arquivos")
    },

    async wait(ms: number) {
      pendingActions.push({ type: "wait", milliseconds: ms })
    },

    async waitFor() {
      await flush(["markdown"])
    },

    async extract(target: TargetRef, attr: ExtractAttr | undefined, many: boolean) {
      const selector = target.selectors[0]
      if (!selector) throw new DriverError("extract sem seletor")

      if (attr && attr !== "text" && attr !== "html" && attr !== "count") {
        const response = await flush([
          { type: "attributes", selectors: [{ selector, attribute: attr }] },
        ])
        const entry = response.data?.attributes?.find((a) => a.selector === selector)
        const values = entry?.values ?? []
        return { value: many ? values : (values[0] ?? null), count: values.length }
      }

      const response = await flush(["html"])
      const values = extractFromHtml(response.data?.html ?? "", selector, attr)
      return { value: many ? values : (values[0] ?? null), count: values.length }
    },

    async assert(target: TargetRef | undefined, expect: Expect, scope) {
      if (!target) {
        if (expect.kind === "equals") {
          const actual = String(scope[expect.value ?? ""] ?? "")
          if (actual !== "") throw new DriverError(`verificação falhou: esperado "${expect.value}"`)
        }
        return
      }
      const response = await flush(["markdown", "html"])
      const content = response.data?.markdown ?? ""
      const selector = target.selectors[0] ?? ""
      switch (expect.kind) {
        case "visible":
        case "exists": {
          const found = extractFromHtml(response.data?.html ?? "", selector, "text")
          if (found.length === 0) throw new DriverError(`verificação falhou: "${selector}" não encontrado`)
          return
        }
        case "hidden": {
          const found = extractFromHtml(response.data?.html ?? "", selector, "text")
          if (found.length > 0) throw new DriverError(`verificação falhou: "${selector}" ainda presente`)
          return
        }
        case "text":
        case "equals": {
          const found = extractFromHtml(response.data?.html ?? "", selector, "text")
          const text = (found[0] ?? "").trim()
          if (text !== (expect.value ?? "")) {
            throw new DriverError(`verificação falhou: "${text}" ≠ "${expect.value ?? ""}"`)
          }
          return
        }
        case "contains": {
          if (!content.includes(expect.value ?? "")) {
            throw new DriverError(`verificação falhou: "${expect.value ?? ""}" não encontrado no conteúdo`)
          }
          return
        }
        case "matches": {
          if (!new RegExp(expect.value ?? "").test(content)) {
            throw new DriverError(`verificação falhou: "${expect.value ?? ""}" não casa com o conteúdo`)
          }
          return
        }
      }
    },

    async eval() {
      throw new DriverError("o alvo os não executa JavaScript na página")
    },

    async screenshot(): Promise<ScreenshotResult> {
      const response = await flush(["screenshot"])
      const url = response.data?.screenshot
      return url ? { path: url } : {}
    },

    async currentUrl() {
      return currentUrl
    },

    async close() {
      pendingActions = []
    },
  }

  return driver
}

/**
 * Extração mínima de HTML, sem dependências de DOM.
 *
 * Suporta os formatos de seletor que o gravador produz: `#id`, `.classe`,
 * `tag`, `tag.classe` e `[attr="valor"]`.
 *
 * Não há suporte a seletores descendentes (`a b`): nesses casos use
 * `attr: "href"`, que passa pelo CSS real do Firecrawl.
 */
export function extractFromHtml(html: string, selector: string, attr?: ExtractAttr): string[] {
  const pattern = buildPattern(selector)
  if (!pattern) return []
  const results: string[] = []
  const regex = new RegExp(pattern, "gi")
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    const chunk = match[0]
    if (attr === "count") {
      results.push(chunk)
      continue
    }
    if (attr && attr !== "text" && attr !== "html") {
      const attrMatch = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(chunk)
      results.push(attrMatch?.[1] ?? "")
      continue
    }
    if (attr === "html") {
      results.push(chunk)
      continue
    }
    results.push(stripTags(chunk))
  }
  return results
}

function buildPattern(selector: string): string | null {
  const trimmed = selector.trim()
  if (!trimmed) return null

  const idMatch = /^#([\w-]+)$/.exec(trimmed)
  if (idMatch) {
    return `<([a-zA-Z][\\w-]*)[^>]*\\sid\\s*=\\s*["']${escapeRegExp(idMatch[1]!)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`
  }

  const attrMatch = /^\[([\w-]+)\s*=\s*["']([^"']*)["']\]$/.exec(trimmed)
  if (attrMatch) {
    return `<([a-zA-Z][\\w-]*)[^>]*\\s${escapeRegExp(attrMatch[1]!)}\\s*=\\s*["']${escapeRegExp(attrMatch[2]!)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`
  }

  const tagClassMatch = /^([a-zA-Z][\w-]*)\.([\w-]+)$/.exec(trimmed)
  if (tagClassMatch) {
    const tag = tagClassMatch[1]!
    const cls = tagClassMatch[2]!
    return `<(${tag})[^>]*\\sclass\\s*=\\s*["'][^"']*\\b${escapeRegExp(cls)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`
  }

  const classMatch = /^\.([\w-]+)$/.exec(trimmed)
  if (classMatch) {
    const cls = classMatch[1]!
    return `<([a-zA-Z][\\w-]*)[^>]*\\sclass\\s*=\\s*["'][^"']*\\b${escapeRegExp(cls)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`
  }

  const tagMatch = /^([a-zA-Z][\w-]*)$/.exec(trimmed)
  if (tagMatch) {
    return `<(${tagMatch[1]})[^>]*>([\\s\\S]*?)<\\/\\1>`
  }

  return null
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
