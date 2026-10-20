import type {
  Driver,
  Expect,
  ExtractAttr,
  ExtractResult,
  ScreenshotResult,
  TargetRef,
} from "@griver/core/runtime"
import { INTERNAL } from "../shared/constants.js"

/**
 * Driver que executa a receita na aba do navegador.
 *
 * Cada operação é enviada ao content script da aba; a navegação é tratada
 * aqui porque destrói o contexto do content script.
 */
export class TabDriver implements Driver {
  readonly target = "browser" as const

  constructor(private readonly tabId: number) {}

  async navigate(url: string): Promise<void> {
    // o documento que está na aba agora: é o que a navegação vai substituir
    const documentoAntes = await this.documentoAtual()
    try {
      await chrome.tabs.update(this.tabId, { url })
    } catch {
      // Algumas versões do Chrome recusam `tabs.update` sem permissão de host
      // ("Navigation rejected."). O content script já está na página e consegue
      // navegar de qualquer forma.
      await injectRecorder(this.tabId)
      try {
        await chrome.tabs.sendMessage(this.tabId, {
          type: INTERNAL.pageCommand,
          command: { action: "navigate", payload: { url } },
        })
      } catch {
        // a própria navegação derruba o content script; seguir para o load
      }
    }
    await waitForLoad(this.tabId, 30_000, documentoAntes)
  }

  async click(target: TargetRef, options?: { clickCount?: number; force?: boolean }): Promise<void> {
    await this.send({ type: "click", target, clickCount: options?.clickCount, force: options?.force })
  }

  async fill(target: TargetRef, value: string): Promise<void> {
    await this.send({ type: "fill", target, value })
  }

  async press(target: TargetRef | undefined, key: string): Promise<void> {
    await this.send({ type: "press", target, key })
  }

  async select(target: TargetRef, value: string): Promise<void> {
    await this.send({ type: "select", target, value })
  }

  async hover(target: TargetRef): Promise<void> {
    await this.send({ type: "hover", target })
  }

  async scrollTo(target: TargetRef | undefined, position?: "top" | "bottom" | "center"): Promise<void> {
    await this.send({ type: "scrollTo", target, position })
  }

  async upload(target: TargetRef, files: string[]): Promise<void> {
    await this.send({ type: "upload", target, files })
  }

  async wait(ms: number): Promise<void> {
    await this.send({ type: "wait", ms })
  }

  async waitFor(
    target: TargetRef,
    state?: "visible" | "hidden" | "attached",
    timeout?: number,
  ): Promise<void> {
    await this.send({ type: "waitFor", target, state, timeout })
  }

  async extract(target: TargetRef, attr: ExtractAttr | undefined, many: boolean): Promise<ExtractResult> {
    const result = await this.send({ type: "extract", target, attr, many })
    return result as ExtractResult
  }

  async assert(target: TargetRef | undefined, expect: Expect, scope: Record<string, unknown>): Promise<void> {
    await this.send({ type: "assert", target, expect, scope })
  }

  async eval(code: string): Promise<unknown> {
    return await this.send({ type: "script", code })
  }

  async screenshot(): Promise<ScreenshotResult> {
    // `captureVisibleTab` recebe o id da JANELA, não o da aba — passar o id da
    // aba faz o Chrome recusar com "No window with id".
    const janela = await this.janelaDaAba()
    // a captura sai da aba ativa da janela: garante que seja a aba controlada
    try {
      await chrome.tabs.update(this.tabId, { active: true })
    } catch {
      // sem permissão para ativar a aba: a captura sai da aba visível da janela
    }
    const dataUrl = await this.capturar(janela)
    const base64 = dataUrl.split(",")[1]
    return { base64, mimeType: "image/png" }
  }

  /**
   * Captura a aba visível.
   *
   * O Chrome recusa a captura com o id da janela em alguns contextos (aba em
   * headless, janela que não está em foco): "No window with id". Nesses casos
   * a captura sem argumento usa a aba visível da janela e funciona.
   */
  private async capturar(janela: number | undefined): Promise<string> {
    if (janela !== undefined) {
      try {
        return await chrome.tabs.captureVisibleTab(janela)
      } catch {
        // o id da janela não valeu: tenta a aba visível
      }
    }
    return await chrome.tabs.captureVisibleTab()
  }

  /** Id da janela que contém a aba controlada (`undefined` se não souber). */
  private async janelaDaAba(): Promise<number | undefined> {
    try {
      const aba = await chrome.tabs.get(this.tabId)
      return aba.windowId
    } catch {
      return undefined
    }
  }

  async currentUrl(): Promise<string> {
    const tab = await chrome.tabs.get(this.tabId)
    return tab.url ?? ""
  }

  /**
   * Identidade do documento que está na aba agora.
   *
   * `undefined` quando não há content script na página — aí não há documento
   * com o que comparar.
   */
  private async documentoAtual(): Promise<string | undefined> {
    try {
      const resposta = (await chrome.tabs.sendMessage(this.tabId, {
        type: INTERNAL.pageCommand,
        command: { action: "context" },
      })) as { ok?: boolean; result?: { documento?: string } } | undefined
      if (!resposta?.ok) return undefined
      return resposta.result?.documento
    } catch {
      return undefined
    }
  }

  async close(): Promise<void> {
    // a aba do usuário permanece aberta
  }

  /** Envia um passo ao content script e devolve o resultado. */
  private async send(command: Record<string, unknown>): Promise<unknown> {
    try {
      const response = (await chrome.tabs.sendMessage(this.tabId, {
        type: INTERNAL.execute,
        command: { step: command },
      })) as { ok: boolean; result?: unknown; error?: string } | undefined

      if (!response) throw new Error("sem resposta do content script")
      if (!response.ok) throw new Error(response.error ?? "erro ao executar o passo")
      return response.result
    } catch (error) {
      if (isDisconnected(error)) {
        // a página recarregou e o content script sumiu: injeta de novo
        await injectRecorder(this.tabId)
        const retry = (await chrome.tabs.sendMessage(this.tabId, {
          type: INTERNAL.execute,
          command: { step: command },
        })) as { ok: boolean; result?: unknown; error?: string } | undefined
        if (!retry?.ok) throw new Error(retry?.error ?? "content script indisponível")
        return retry.result
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
}

/** Garante que o content script esteja presente na aba. */
export async function injectRecorder(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: INTERNAL.pageCommand, command: { action: "context" } })
    return
  } catch {
    // a aba pode ter sido aberta antes da extensão: injeta o script agora
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    })
  } catch (error) {
    const detalhe = error instanceof Error ? error.message : String(error)
    throw new Error(
      `não foi possível agir nesta página (${detalhe}). ` +
        "Recarregue a aba e tente de novo; páginas internas do navegador não podem ser gravadas.",
    )
  }
}

/**
 * Aguarda a aba terminar de carregar.
 *
 * A checagem imediata de `status === "complete"` resolve com a página antiga:
 * depois de pedir a navegação, a aba ainda está completa por um instante. Por
 * isso esperamos um pouco antes de começar a observar.
 *
 * Quando o documento antigo é conhecido, a espera é mais firme: o passo
 * seguinte só roda depois que o content script do documento novo responder.
 * Sem isso, um `fill` logo depois de `navigate` pode escrever no documento
 * que está saindo — e o valor se perde com a navegação.
 */
export async function waitForLoad(
  tabId: number,
  timeoutMs = 30_000,
  documentoAntes?: string,
): Promise<void> {
  const inicio = Date.now()
  const restante = () => timeoutMs - (Date.now() - inicio)

  // o documento novo: o content script dele responde com um id diferente
  let documentoNovo = false
  if (documentoAntes !== undefined) {
    const limite = Math.min(restante(), 15_000)
    while (Date.now() - inicio < limite) {
      const atual = await documentoDaAba(tabId)
      if (atual !== undefined && atual !== documentoAntes) {
        documentoNovo = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  // sem documento para comparar, a aba pode estar "completa" e ainda ser a
  // antiga: a navegação só foi pedida. Uma pausa curta evita resolver com a
  // página que está saindo.
  if (!documentoNovo) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  while (restante() > 0) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === "complete") return
    } catch {
      // aba fechada durante a navegação
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  throw new Error("tempo esgotado aguardando o carregamento da página")
}

/** Identidade do documento que está na aba (undefined se não houver content script). */
async function documentoDaAba(tabId: number): Promise<string | undefined> {
  try {
    const resposta = (await chrome.tabs.sendMessage(tabId, {
      type: INTERNAL.pageCommand,
      command: { action: "context" },
    })) as { ok?: boolean; result?: { documento?: string } } | undefined
    if (!resposta?.ok) return undefined
    return resposta.result?.documento
  } catch {
    // a página está mudando: o content script antigo já foi
    return undefined
  }
}

function isDisconnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("message port closed") ||
    message.includes("Extension context invalidated")
  )
}
