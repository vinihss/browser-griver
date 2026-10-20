import type { Expect, ExtractAttr, TargetKind, TargetRef } from "../recipe/schema.js"

export interface ExtractResult {
  /** valor extraído (string quando `many` é falso, lista quando é true) */
  value: unknown
  /** número de elementos casados */
  count: number
}

export interface ClickOptions {
  clickCount?: number
  force?: boolean
}

export interface ScreenshotResult {
  /** caminho do arquivo salvo, quando o driver salva em disco */
  path?: string
  /** conteúdo base64, quando o driver devolve bytes */
  base64?: string
  mimeType?: string
}

/**
 * Contrato de automação. Cada motor (Playwright, executor na aba, Firecrawl)
 * implementa esta interface e o interpretador da receita é o mesmo para todos.
 */
export interface Driver {
  /** alvo que este driver executa */
  readonly target: TargetKind

  navigate(url: string): Promise<void>
  click(target: TargetRef, options?: ClickOptions): Promise<void>
  fill(target: TargetRef, value: string): Promise<void>
  press(target: TargetRef | undefined, key: string): Promise<void>
  select(target: TargetRef, value: string): Promise<void>
  hover(target: TargetRef): Promise<void>
  scrollTo(target: TargetRef | undefined, position?: "top" | "bottom" | "center"): Promise<void>
  upload(target: TargetRef, files: string[]): Promise<void>
  wait(ms: number): Promise<void>
  waitFor(target: TargetRef, state?: "visible" | "hidden" | "attached", timeout?: number): Promise<void>
  extract(target: TargetRef, attr: ExtractAttr | undefined, many: boolean): Promise<ExtractResult>
  assert(target: TargetRef | undefined, expect: Expect, scope: Record<string, unknown>): Promise<void>
  /** executa JavaScript no contexto da página */
  eval(code: string): Promise<unknown>
  screenshot(options?: { fullPage?: boolean }): Promise<ScreenshotResult>
  currentUrl(): Promise<string>
  close(): Promise<void>
}

/** Erro de execução de um passo, com contexto suficiente para depurar. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly detail?: {
      triedSelectors?: string[]
      url?: string
      cause?: unknown
    },
  ) {
    super(message)
    this.name = "DriverError"
  }
}
