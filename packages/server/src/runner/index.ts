import { runRecipe, type Driver, type Recipe, type RunResult, type StepEvent } from "@griver/core"
import type { Repository } from "../db/repo.js"

export interface RunRequest {
  recipe: Recipe
  recipeId?: string
  recipeName?: string
  driver: string
  vars?: Record<string, unknown>
  /** cria o driver; o runner fecha ao terminar */
  createDriver: () => Promise<Driver>
}

export interface RunHandle {
  id: string
  status: string
  promise: Promise<RunResult>
  cancel(): void
}

export interface RunManagerOptions {
  repo: Repository
  onEvent?: (runId: string, event: StepEvent) => void
  onFinished?: (runId: string, result: RunResult) => void
  defaultTimeout?: number
}

/**
 * Gerencia execuções de receitas.
 *
 * Cada execução roda o interpretador contra um driver, persiste o log e
 * transmite os eventos de passo para a interface.
 */
export class RunManager {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly options: RunManagerOptions) {}

  async start(request: RunRequest): Promise<RunHandle> {
    const run = this.options.repo.createRun({
      recipeId: request.recipeId,
      recipeName: request.recipeName,
      driver: request.driver,
      status: "running",
    })

    const controller = new AbortController()
    this.controllers.set(run.id, controller)

    const promise = (async (): Promise<RunResult> => {
      let driver: Driver | undefined
      const events: StepEvent[] = []
      try {
        driver = await request.createDriver()
        const result = await runRecipe(request.recipe, driver, {
          scope: request.vars,
          signal: controller.signal,
          defaultTimeout: this.options.defaultTimeout,
          onStep: (event) => {
            events.push(event)
            this.options.onEvent?.(run.id, event)
          },
        })

        this.options.repo.updateRun(run.id, {
          status: result.status,
          endedAt: Date.now(),
          error: result.error?.message,
          scope: stripInternals(result.scope),
          log: events,
        })
        this.options.onFinished?.(run.id, result)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.repo.updateRun(run.id, {
          status: "error",
          endedAt: Date.now(),
          error: message,
          log: events,
        })
        const failed: RunResult = {
          status: "error",
          scope: {},
          error: { message },
          steps: events,
        }
        this.options.onFinished?.(run.id, failed)
        return failed
      } finally {
        this.controllers.delete(run.id)
        await driver?.close().catch(() => undefined)
      }
    })()

    return {
      id: run.id,
      status: run.status,
      promise,
      cancel: () => this.cancel(run.id),
    }
  }

  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  get activeRuns(): string[] {
    return [...this.controllers.keys()]
  }
}

/** Remove chaves internas do escopo antes de persistir. */
function stripInternals(scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scope)) {
    if (key.startsWith("__")) continue
    out[key] = value
  }
  return out
}
