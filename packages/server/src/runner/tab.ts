import type { Recipe, RunResult, StepEvent } from "@griver/core"
import type { Repository } from "../db/repo.js"
import type { WsGateway } from "../ws/gateway.js"

interface PendingRun {
  resolve: (result: RunResult) => void
  timer: NodeJS.Timeout
}

/**
 * Coordena execuções que acontecem dentro da aba do navegador.
 *
 * O servidor cria a execução, pede à extensão que rode a receita na aba e
 * aguarda o resultado reportado por ela.
 */
export class TabRunCoordinator {
  private readonly pending = new Map<string, PendingRun>()

  constructor(
    private readonly gateway: WsGateway,
    private readonly repo: Repository,
  ) {}

  /** Pede à extensão que execute a receita na aba ativa. */
  async requestRun(
    runId: string,
    recipeId: string,
    recipe: Recipe,
    vars?: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<RunResult> {
    const result = await new Promise<RunResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(runId)
        resolve({
          status: "error",
          scope: {},
          error: { message: "tempo esgotado aguardando a execução na aba" },
          steps: [],
        })
      }, timeoutMs)

      this.pending.set(runId, { resolve, timer })
      this.gateway.broadcast({
        type: "run.request",
        runId,
        recipeId,
        recipe,
        vars,
      })
    })

    this.repo.updateRun(runId, {
      status: result.status,
      endedAt: Date.now(),
      error: result.error?.message,
      scope: result.scope,
      log: result.steps,
    })
    return result
  }

  /** Recebe o resultado reportado pela extensão. */
  handleResult(input: {
    runId: string
    status: "ok" | "error" | "aborted"
    events: StepEvent[]
    error?: string
    scope?: Record<string, unknown>
  }): void {
    const pending = this.pending.get(input.runId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(input.runId)

    pending.resolve({
      status: input.status,
      scope: input.scope ?? {},
      error: input.error ? { message: input.error } : undefined,
      steps: input.events,
    })
  }
}
