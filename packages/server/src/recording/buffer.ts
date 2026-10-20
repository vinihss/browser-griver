import { stepId, type Recipe, type RecordedEvent, type Step, type TargetRef } from "@griver/core"

export type RecordingStatus = "idle" | "recording" | "paused"

export interface RecordingSnapshot {
  id: string
  projectId?: string
  status: RecordingStatus
  events: RecordedEvent[]
  startedAt: number
  updatedAt: number
}

/**
 * Guarda a gravação em andamento.
 *
 * A extensão envia os eventos capturados; o servidor mantém a lista e a
 * converte em passos de receita quando a gravação é concluída.
 */
export class RecordingBuffer {
  private id = ""
  private projectId: string | undefined
  private status: RecordingStatus = "idle"
  private events: RecordedEvent[] = []
  private startedAt = 0
  private updatedAt = 0

  start(projectId?: string): RecordingSnapshot {
    this.id = stepId("rec")
    this.projectId = projectId
    this.status = "recording"
    this.events = []
    this.startedAt = Date.now()
    this.updatedAt = this.startedAt
    return this.snapshot()
  }

  pause(): RecordingSnapshot {
    if (this.status === "recording") this.status = "paused"
    this.updatedAt = Date.now()
    return this.snapshot()
  }

  resume(): RecordingSnapshot {
    if (this.status === "paused") this.status = "recording"
    this.updatedAt = Date.now()
    return this.snapshot()
  }

  /** Eventos gravados enquanto pausado são ignorados. */
  push(event: RecordedEvent): RecordingSnapshot {
    if (this.status === "recording") {
      this.events.push(event)
      this.updatedAt = Date.now()
    }
    return this.snapshot()
  }

  stop(): { snapshot: RecordingSnapshot; recipe: Recipe } {
    const snapshot = this.snapshot()
    const recipe = this.toRecipe()
    this.reset()
    return { snapshot, recipe }
  }

  discard(): RecordingSnapshot {
    const snapshot = this.snapshot()
    this.reset()
    return snapshot
  }

  reset(): void {
    this.id = ""
    this.projectId = undefined
    this.status = "idle"
    this.events = []
    this.startedAt = 0
    this.updatedAt = 0
  }

  snapshot(): RecordingSnapshot {
    return {
      id: this.id,
      projectId: this.projectId,
      status: this.status,
      events: [...this.events],
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    }
  }

  get isActive(): boolean {
    return this.status !== "idle"
  }

  /**
   * Converte os eventos capturados em passos de receita.
   *
   * Passos de digitação no mesmo campo com o mesmo valor viram um único
   * `fill` — `input` e `change` disparam juntos e produziriam duplicatas.
   */
  toRecipe(): Recipe {
    const steps: Step[] = []
    /** preenchimentos ainda não emitidos, por campo */
    const pending = new Map<string, { step: Step & { type: "fill" }; value: string }>()
    /** último valor gravado por campo, para evitar duplicatas */
    const emitted = new Map<string, string>()

    const flush = () => {
      for (const entry of pending.values()) {
        steps.push(entry.step)
        emitted.set(entry.step.target.selectors[0] ?? "", entry.value)
      }
      pending.clear()
    }

    for (const event of this.events) {
      switch (event.kind) {
        case "navigate": {
          flush()
          const url = normalizeUrl(event.url)
          if (!url) break
          if (steps[steps.length - 1]?.type === "navigate") break
          steps.push({ id: stepId(), type: "navigate", url })
          break
        }
        case "click": {
          flush()
          const target = targetFrom(event)
          if (!target) break
          steps.push({ id: stepId(), type: "click", target })
          break
        }
        case "input":
        case "change": {
          const target = targetFrom(event)
          if (!target) break
          const field = target.selectors[0] ?? ""
          const value = event.value ?? ""

          // `input` e `change` disparam juntos: o mesmo valor no mesmo campo
          // vira um único passo
          if (emitted.get(field) === value) break
          const existing = pending.get(field)
          if (existing) {
            existing.value = value
            existing.step.value = value
            break
          }

          pending.set(field, {
            step: { id: stepId(), type: "fill", target, value },
            value,
          })
          break
        }
        case "select": {
          flush()
          const target = targetFrom(event)
          if (!target) break
          const field = target.selectors[0] ?? ""
          const value = event.value ?? ""
          // o mesmo select pode ser gravado mais de uma vez
          if (emitted.get(field) === value) break
          steps.push({ id: stepId(), type: "select", target, value })
          emitted.set(field, value)
          break
        }
        case "keydown": {
          flush()
          if (!event.key) break
          const target = event.selector ? targetFrom(event) : undefined
          steps.push({ id: stepId(), type: "press", key: event.key, ...(target ? { target } : {}) })
          break
        }
        case "scroll": {
          flush()
          steps.push({ id: stepId(), type: "scrollTo" })
          break
        }
        case "submit": {
          flush()
          break
        }
      }
    }
    flush()

    const startUrl = steps.find((s) => s.type === "navigate")
    return {
      version: 1,
      ...(startUrl && startUrl.type === "navigate" ? { startUrl: startUrl.url } : {}),
      steps,
    }
  }
}

function targetFrom(event: RecordedEvent): TargetRef | undefined {
  const selectors = event.selectors?.length ? event.selectors : event.selector ? [event.selector] : []
  if (!selectors.length) return undefined
  const target: TargetRef = { selectors }
  if (event.text) target.text = event.text
  return target
}

/** Remove hash e parâmetros voláteis, mantendo a URL utilizável. */
function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return undefined
  }
}
