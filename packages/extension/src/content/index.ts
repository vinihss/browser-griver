import { INTERNAL } from "../shared/constants.js"
import { Recorder } from "./recorder.js"
import { RecordingOverlay, type OverlayState } from "./overlay.js"
import * as executor from "./executor.js"
import { buildSelectorCandidates, visibleText } from "./selector.js"

const recorder = new Recorder()
const overlay = new RecordingOverlay()

/**
 * Identidade do documento.
 *
 * O content script roda uma vez por documento, então este id muda sempre que
 * a página muda. Quem navega usa isso para esperar o documento novo: a aba
 * pode estar "completa" e ainda ser a antiga — o passo seguinte cairia no
 * documento que está saindo e o que o fill escreve nele se perderia.
 */
const DOCUMENTO = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

interface RecordCommand {
  action: "start" | "pause" | "resume" | "stop"
}

interface ExecuteCommand {
  step: { type: string; target?: never; [key: string]: unknown }
}

interface PageCommand {
  action: "context" | "click" | "fill" | "evaluate" | "screenshot" | "navigate"
  payload?: Record<string, unknown>
}

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  switch (message.type) {
    case INTERNAL.recordCommand: {
      const command = message.command as RecordCommand
      if (command.action === "start") {
        recorder.start((event) => {
          void chrome.runtime.sendMessage({ type: INTERNAL.recordEvent, event }).catch(() => undefined)
        })
      } else if (command.action === "pause") {
        recorder.pause()
      } else if (command.action === "resume") {
        recorder.resume()
      } else if (command.action === "stop") {
        const restantes = recorder.stop()
        sendResponse({ ok: true, events: restantes })
        return false
      }
      sendResponse({ ok: true })
      return false
    }

    case INTERNAL.overlayState: {
      overlay.render(message.state as OverlayState)
      return false
    }

    case INTERNAL.execute: {
      const command = message.command as ExecuteCommand
      void runStep(command.step)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      return true
    }

    case INTERNAL.pageCommand: {
      const command = message.command as PageCommand
      void runPageCommand(command)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      return true
    }

    default:
      return false
  }
})

// O overlay pergunta o que exibir assim que a página carrega — é assim que
// ele reaparece depois de uma navegação, sem depender do service worker.
//
// A mesma resposta diz se a gravação continua ativa: nesse caso a captura
// precisa ser retomada, porque este é um content script novo.
void overlay.mount().then((estado) => {
  if (estado.recording && !estado.paused) {
    recorder.start((event) => {
      void chrome.runtime.sendMessage({ type: INTERNAL.recordEvent, event }).catch(() => undefined)
    })
  }
})

/** Executa um passo da receita dentro da aba. */
async function runStep(step: Record<string, unknown>): Promise<unknown> {
  const target = step.target as never
  switch (step.type) {
    case "click":
      executor.click(target, {
        clickCount: (step.clickCount as number) ?? 1,
        force: (step.force as boolean) ?? false,
      })
      return undefined
    case "fill":
      executor.fill(target, String(step.value ?? ""))
      return undefined
    case "press":
      executor.press(step.target ? target : undefined, String(step.key ?? ""))
      return undefined
    case "select":
      executor.select(target, String(step.value ?? ""))
      return undefined
    case "hover":
      executor.hover(target)
      return undefined
    case "scrollTo":
      executor.scrollTo(step.target ? target : undefined, step.position as never)
      return undefined
    case "upload":
      executor.upload(target, (step.files as string[]) ?? [])
      return undefined
    case "wait":
      await executor.wait(Number(step.ms ?? 0))
      return undefined
    case "waitFor":
      await executor.waitFor(target, step.state as never, Number(step.timeout ?? 30000))
      return undefined
    case "extract":
      return executor.extract(target, step.attr as never, step.many === true)
    case "assert":
      executor.assert(step.target ? target : undefined, step.expect as never, {})
      return undefined
    case "script":
      return executor.evaluate(String(step.code ?? ""))
    case "currentUrl":
      return executor.currentUrl()
    default:
      throw new Error(`passo não suportado na aba: ${String(step.type)}`)
  }
}

/** Comandos de inspeção e manipulação usados pelo assistente de IA. */
async function runPageCommand(command: PageCommand): Promise<unknown> {
  switch (command.action) {
    case "context":
      return pageContext()
    case "click":
      executor.click(command.payload?.target as never, command.payload?.options as never)
      return { ok: true }
    case "fill":
      executor.fill(command.payload?.target as never, String(command.payload?.value ?? ""))
      return { ok: true }
    case "evaluate":
      return executor.evaluate(String(command.payload?.code ?? ""))
    case "screenshot":
      return { ok: true }
    case "navigate":
      // usado quando o Chrome recusa `chrome.tabs.update` para a aba
      window.location.href = String(command.payload?.url ?? "")
      return { ok: true }
    default:
      throw new Error(`comando de página desconhecido: ${command.action}`)
  }
}

/** Instantâneo da página com os elementos interativos e seus seletores. */
function pageContext(): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  const interactive = document.querySelectorAll(
    "a, button, input, textarea, select, [role=button], [onclick], [contenteditable=true]",
  )

  for (const element of Array.from(interactive).slice(0, 120)) {
    const candidates = buildSelectorCandidates(element)
    if (!candidates.length) continue
    elements.push({
      tag: element.tagName.toLowerCase(),
      type: element instanceof HTMLInputElement ? element.type : undefined,
      text: visibleText(element, 40),
      value:
        element instanceof HTMLInputElement && element.type !== "password"
          ? element.value
          : undefined,
      placeholder:
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.placeholder
          : undefined,
      selectors: candidates.map((candidate) => candidate.selector),
    })
  }

  return {
    url: location.href,
    title: document.title,
    documento: DOCUMENTO,
    elements,
  }
}
