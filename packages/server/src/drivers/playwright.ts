import type { Driver, ExtractAttr, Expect, ScreenshotResult, TargetRef } from "@griver/core"
import { DriverError } from "@griver/core"

export interface PlaywrightDriverOptions {
  headed?: boolean
  /** endpoint CDP de um Chrome já aberto, ex.: http://127.0.0.1:9222 */
  cdpUrl?: string
  /** diretório de perfil persistente ( reaproveita login) */
  userDataDir?: string
  /** usa o Chrome do sistema em vez do Chromium do Playwright */
  channel?: "chrome" | "chromium"
  defaultTimeout?: number
  artifactsDir?: string
  timeout?: number
}

/** Tipos mínimos da API do Playwright, para não acoplar o pacote inteiro. */
interface PlaywrightLike {
  locator(selector: string): any
  frameLocator(selector: string): any
  goto(url: string, options?: unknown): Promise<unknown>
  keyboard: { press(key: string): Promise<void> }
  mouse: { down(): Promise<void>; up(): Promise<void> }
  waitForTimeout(ms: number): Promise<void>
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>
  screenshot(options?: unknown): Promise<Buffer>
  url(): string
  title(): Promise<string>
  content(): Promise<string>
  close(): Promise<void>
}

interface FrameLike {
  locator(selector: string): any
  url(): string
}

interface ContextLike {
  newPage(): Promise<PlaywrightLike>
  pages(): PlaywrightLike[]
  close(): Promise<void>
}

interface BrowserLike {
  newContext(options?: unknown): Promise<ContextLike>
  contexts(): ContextLike[]
  close(): Promise<void>
}

interface PlaywrightModule {
  chromium: {
    launch(options?: unknown): Promise<BrowserLike>
    launchPersistentContext(dir: string, options?: unknown): Promise<ContextLike>
    connectOverCDP(url: string, options?: unknown): Promise<BrowserLike>
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import("playwright")) as unknown as PlaywrightModule
  } catch (error) {
    throw new Error(
      "Playwright não está instalado. Rode `pnpm install` no projeto ou use o driver na aba do navegador.",
      { cause: error },
    )
  }
}

/**
 * Driver que executa a receita em um navegador real via Playwright.
 *
 * Suporta navegador recém-aberto (headless ou headful), perfil persistente e
 * conexão CDP a um Chrome já em execução.
 */
export async function createPlaywrightDriver(options: PlaywrightDriverOptions = {}): Promise<Driver> {
  const pw = await loadPlaywright()
  const timeout = options.timeout ?? 30_000
  const defaultTimeout = options.defaultTimeout ?? timeout

  let context: ContextLike
  let browser: BrowserLike | undefined
  let page: PlaywrightLike
  let ownsBrowser = true

  if (options.cdpUrl) {
    browser = await pw.chromium.connectOverCDP(options.cdpUrl)
    const contexts = browser.contexts()
    context = contexts[0] ?? (await browser.newContext())
    const pages = context.pages()
    page = pages[0] ?? (await context.newPage())
    ownsBrowser = false
  } else if (options.userDataDir) {
    context = await pw.chromium.launchPersistentContext(options.userDataDir, {
      headless: options.headed ? false : true,
      channel: options.channel,
      viewport: { width: 1440, height: 900 },
    })
    const pages = context.pages()
    page = pages[0] ?? (await context.newPage())
  } else {
    browser = await pw.chromium.launch({
      headless: options.headed ? false : true,
      channel: options.channel,
    })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
  }

  const driver: Driver = {
    target: "browser",

    async navigate(url: string) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout })
      } catch (error) {
        throw new DriverError(`falha ao navegar para ${url}`, { url, cause: error })
      }
    },

    async click(target: TargetRef, clickOptions) {
      const locator = await resolve(page, target, defaultTimeout)
      await locator.click({
        clickCount: clickOptions?.clickCount ?? 1,
        force: clickOptions?.force ?? false,
        timeout: defaultTimeout,
      })
    },

    async fill(target: TargetRef, value: string) {
      const locator = await resolve(page, target, defaultTimeout)
      await locator.fill(value, { timeout: defaultTimeout })
    },

    async press(target: TargetRef | undefined, key: string) {
      if (!target) {
        await page.keyboard.press(key)
        return
      }
      const locator = await resolve(page, target, defaultTimeout)
      await locator.press(key, { timeout: defaultTimeout })
    },

    async select(target: TargetRef, value: string) {
      const locator = await resolve(page, target, defaultTimeout)
      await locator.selectOption(value, { timeout: defaultTimeout })
    },

    async hover(target: TargetRef) {
      const locator = await resolve(page, target, defaultTimeout)
      await locator.hover({ timeout: defaultTimeout })
    },

    async scrollTo(target: TargetRef | undefined, position) {
      if (!target) {
        await page.evaluate((pos: string) => {
          if (pos === "top") window.scrollTo({ top: 0, behavior: "smooth" })
          else if (pos === "center")
            window.scrollTo({ top: document.body.scrollHeight / 2, behavior: "smooth" })
          else window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
        }, position ?? "bottom")
        return
      }
      const locator = await resolve(page, target, defaultTimeout)
      await locator.scrollIntoViewIfNeeded({ timeout: defaultTimeout })
    },

    async upload(target: TargetRef, files: string[]) {
      const locator = await resolve(page, target, defaultTimeout)
      await locator.setInputFiles(files, { timeout: defaultTimeout })
    },

    async wait(ms: number) {
      await page.waitForTimeout(ms)
    },

    async waitFor(target: TargetRef, state = "visible", waitTimeout) {
      const locator = await resolve(page, target, waitTimeout ?? defaultTimeout, { requireMatch: false })
      await locator.waitFor({ state, timeout: waitTimeout ?? defaultTimeout })
    },

    async extract(target: TargetRef, attr: ExtractAttr | undefined, many: boolean) {
      const locator = await resolve(page, target, defaultTimeout)
      if (many) {
        const all = await locator.all()
        const values = await Promise.all(all.map((element: any) => readAttribute(element, attr)))
        return { value: values, count: values.length }
      }
      const value = await readAttribute(locator, attr)
      return { value, count: 1 }
    },

    async assert(target: TargetRef | undefined, expect: Expect, scope) {
      if (!target) {
        if (expect.kind === "equals") {
          const actual = String(scope[expect.value ?? ""] ?? "")
          if (actual !== "") throw new DriverError(`verificação falhou: esperado "${expect.value}"`)
        }
        return
      }
      const locator = await resolve(page, target, defaultTimeout)
      switch (expect.kind) {
        case "visible": {
          if (!(await locator.isVisible())) throw new DriverError("verificação falhou: elemento não está visível")
          return
        }
        case "hidden": {
          if (await locator.isVisible()) throw new DriverError("verificação falhou: elemento ainda está visível")
          return
        }
        case "exists": {
          if ((await locator.count()) === 0) throw new DriverError("verificação falhou: elemento não existe")
          return
        }
        case "text":
        case "equals": {
          const text = ((await locator.innerText()) ?? "").trim()
          if (expect.kind === "text" && text !== (expect.value ?? "")) {
            throw new DriverError(`verificação falhou: texto "${text}" ≠ "${expect.value ?? ""}"`)
          }
          return
        }
        case "contains": {
          const text = ((await locator.innerText()) ?? "").trim()
          if (!text.includes(expect.value ?? "")) {
            throw new DriverError(`verificação falhou: "${expect.value ?? ""}" não encontrado em "${text}"`)
          }
          return
        }
        case "matches": {
          const text = ((await locator.innerText()) ?? "").trim()
          if (!new RegExp(expect.value ?? "").test(text)) {
            throw new DriverError(`verificação falhou: "${expect.value ?? ""}" não casa com "${text}"`)
          }
          return
        }
      }
    },

    async eval(code: string) {
      return await page.evaluate(code)
    },

    async screenshot(screenshotOptions): Promise<ScreenshotResult> {
      const buffer = await page.screenshot({ fullPage: screenshotOptions?.fullPage ?? false })
      return { base64: buffer.toString("base64"), mimeType: "image/png" }
    },

    async currentUrl() {
      return page.url()
    },

    async close() {
      try {
        if (ownsBrowser) {
          await context.close()
          await browser?.close()
        }
      } catch {
        /* ignora falhas de encerramento */
      }
    },
  }

  return driver
}

async function readAttribute(locator: any, attr: ExtractAttr | undefined): Promise<unknown> {
  switch (attr) {
    case "html":
      return await locator.innerHTML()
    case "href":
      return await locator.getAttribute("href")
    case "value":
      return await locator.inputValue()
    case "src":
      return await locator.getAttribute("src")
    case "count":
      return await locator.count()
    default:
      return (await locator.innerText())?.trim()
  }
}

/**
 * Resolve um `TargetRef` testando cada seletor candidato até um casar.
 * Erros incluem a lista de seletores tentados para facilitar o diagnóstico.
 */
export async function resolve(
  page: PlaywrightLike,
  target: TargetRef,
  timeout: number,
  options: { requireMatch?: boolean } = {},
): Promise<any> {
  const requireMatch = options.requireMatch ?? true
  const tried: string[] = []

  let scope: any = page
  for (const frameSelector of target.frames ?? []) {
    tried.push(`frame:${frameSelector}`)
    scope = scope.frameLocator(frameSelector)
  }

  for (const selector of target.selectors) {
    tried.push(selector)
    const locator = scope.locator(selector)
    try {
      const count = await locator.count()
      if (count > 0) {
        const first = locator.first()
        if (!requireMatch) return first
        await first.waitFor({ state: "attached", timeout })
        return first
      }
    } catch {
      // tenta o próximo candidato
    }
  }

  if (target.text) {
    tried.push(`text:"${target.text}"`)
    const byText = scope.locator(`text=${target.text}`)
    try {
      if ((await byText.count()) > 0) return byText.first()
    } catch {
      // ignora
    }
  }

  throw new DriverError(
    `nenhum seletor casou com o elemento (tentados: ${tried.join(", ")})`,
    { triedSelectors: tried, url: safeUrl(page) },
  )
}

function safeUrl(page: PlaywrightLike): string | undefined {
  try {
    return page.url()
  } catch {
    return undefined
  }
}
