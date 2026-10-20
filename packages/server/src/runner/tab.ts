import type { Recipe, RunResult, RunSummary, StepEvent } from "@griver/core"
import type { Repository } from "../db/repo.js"
import type { WsGateway, ClientConnection } from "../ws/gateway.js"

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
  /** Execuções em espera, por extensão: a aba ativa é um recurso único. */
  private readonly fila = new Map<string, Promise<void>>()

  constructor(
    private readonly gateway: WsGateway,
    private readonly repo: Repository,
  ) {}

  /**
   * Pede à extensão que execute a receita na aba ativa.
   *
   * O comando vai para uma única extensão: quem pediu a execução, quando
   * vem do próprio WebSocket, ou a primeira conectada quando a execução
   * partiu de uma chamada HTTP. Enviar para todas faria cada extensão
   * executar a receita na sua aba ativa — sequestrando abas de outros
   * navegadores.
   *
   * O começo e o fim da execução também vão só para ela: o painel de outra
   * extensão mostrar "Execução concluída" por uma receita que rodou em
   * outro navegador confunde quem está usando.
   */
  async requestRun(
    run: RunSummary,
    recipeId: string,
    recipe: Recipe,
    vars?: Record<string, unknown>,
    target?: ClientConnection,
    timeoutMs = 120_000,
  ): Promise<RunResult> {
    const client = target ?? this.gateway.firstAuthenticatedClient()
    if (!client) {
      const result: RunResult = {
        status: "error",
        scope: {},
        error: { message: "nenhuma extensão conectada" },
        steps: [],
      }
      this.repo.updateRun(run.id, {
        status: "error",
        endedAt: Date.now(),
        error: result.error?.message,
        scope: {},
        log: [],
      })
      return result
    }

    // Uma execução por vez na mesma aba.
    //
    // A aba é um recurso único: duas receitas simultâneas se atropelam — o
    // `navigate` de uma apaga o DOM que a outra está lendo, e o passo
    // seguinte enxerga a página errada (o `extract` devolve o texto certo e o
    // `assert` seguinte lê a página que a outra execução recarregou). A
    // fila espera a execução anterior terminar — ou esgotar o tempo — antes
    // de mandar o comando.
    const anterior = this.fila.get(client.id) ?? Promise.resolve()
    let liberar!: () => void
    const minha = new Promise<void>((resolve) => {
      liberar = resolve
    })
    const corrente = anterior.then(
      () => minha,
      () => minha,
    )
    this.fila.set(client.id, corrente)
    await anterior.catch(() => undefined)

    try {
      this.gateway.send(client, { type: "run.started", run })

      const result = await new Promise<RunResult>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(run.id)
          resolve({
            status: "error",
            scope: {},
            error: { message: "tempo esgotado aguardando a execução na aba" },
            steps: [],
          })
        }, timeoutMs)

        this.pending.set(run.id, { resolve, timer })
        this.gateway.send(client, {
          type: "run.request",
          runId: run.id,
          recipeId,
          recipe,
          vars,
        })
      })

      this.repo.updateRun(run.id, {
        status: result.status,
        endedAt: Date.now(),
        error: result.error?.message,
        scope: result.scope,
        log: result.steps,
      })

      const finished = this.repo.getRun(run.id)
      if (finished) this.gateway.send(client, { type: "run.finished", run: finished })
      return result
    } catch (erro) {
      // a extensão caiu no meio do caminho: a execução não pode ficar
      // pendurada no painel à espera de um tempo que não vem
      const mensagem = erro instanceof Error ? erro.message : String(erro)
      this.repo.updateRun(run.id, {
        status: "error",
        endedAt: Date.now(),
        error: mensagem,
        scope: {},
        log: [],
      })
      const finished = this.repo.getRun(run.id)
      if (finished) this.gateway.send(client, { type: "run.finished", run: finished })
      return {
        status: "error",
        scope: {},
        error: { message: mensagem },
        steps: [],
      }
    } finally {
      // a fila só é liberada no fim: um `return` antecipado deixaria a aba
      // travada para as próximas execuções
      liberar()
      if (this.fila.get(client.id) === corrente) this.fila.delete(client.id)
    }
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
