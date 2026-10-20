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

/** Sessão usada quando a chamada não informa qual extensão é dona. */
const SEM_CLIENTE = "default"

/**
 * Guarda as gravações em andamento.
 *
 * Cada extensão tem a sua própria gravação: os eventos capturados por uma
 * não podem entrar na receita de outra, senão a receita sai com passos que
 * nunca aconteceram. As chamadas sem `clientId` mexem na gravação corrente —
 * a última que começou.
 */
export class RecordingBuffer {
  private readonly sessions = new Map<string, RecordingSession>()
  /** extensão dona da gravação corrente */
  private corrente = SEM_CLIENTE
  /** última gravação encerrada — quem chamou `stop` pelo HTTP precisa dela */
  private ultimoFinalizado: { snapshot: RecordingSnapshot; recipe: Recipe } | undefined

  start(clientId: string | undefined, projectId?: string): RecordingSnapshot {
    const dono = clientId ?? SEM_CLIENTE
    const session: RecordingSession = {
      id: stepId("rec"),
      projectId,
      status: "recording",
      events: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(dono, session)
    this.corrente = dono
    // uma gravação nova invalida a anterior: quem espera o fim não pode
    // receber a receita de uma gravação velha
    this.ultimoFinalizado = undefined
    return this.snapshot(dono)
  }

  pause(clientId?: string): RecordingSnapshot {
    const session = this.session(clientId)
    if (session && session.status === "recording") session.status = "paused"
    if (session) session.updatedAt = Date.now()
    return this.snapshot(clientId)
  }

  /**
   * Uma extensão assume a gravação.
   *
   * Quando a API abriu a gravação (por HTTP), a sessão não tem dona: a
   * primeira extensão a falar dela a adota, em vez de criar outra — duas
   * sessões fariam os passos se dividirem entre elas.
   */
  assumir(clientId: string, projectId?: string): RecordingSnapshot {
    const semDono = this.sessions.get(SEM_CLIENTE)
    if (semDono) {
      this.sessions.delete(SEM_CLIENTE)
      if (projectId) semDono.projectId = projectId
      this.sessions.set(clientId, semDono)
      this.corrente = clientId
      return this.snapshot(clientId)
    }
    return this.start(clientId, projectId)
  }

  resume(clientId?: string): RecordingSnapshot {
    const session = this.session(clientId)
    if (session && session.status === "paused") session.status = "recording"
    if (session) session.updatedAt = Date.now()
    return this.snapshot(clientId)
  }

  /** Eventos gravados enquanto pausado são ignorados. */
  push(event: RecordedEvent, clientId?: string): RecordingSnapshot {
    const session = this.sessaoDoEvento(clientId)
    if (session && session.status === "recording") {
      session.events.push(event)
      session.updatedAt = Date.now()
    }
    return this.snapshot(clientId)
  }

  stop(clientId?: string): { snapshot: RecordingSnapshot; recipe: Recipe } {
    const dono = this.dono(clientId)
    const session = this.sessions.get(dono)
    const snapshot = this.snapshot(clientId)
    const recipe = this.toRecipe(session?.events ?? [])
    this.sessions.delete(dono)
    if (this.corrente === dono) this.corrente = SEM_CLIENTE
    this.ultimoFinalizado = { snapshot, recipe }
    return { snapshot, recipe }
  }

  /**
   * A última gravação encerrada.
   *
   * Quem parou a gravação foi a extensão (por WebSocket), mas quem pediu
   * o `stop` foi a API — ela precisa da receita pronta, e a extensão já
   * levou a sua parte.
   */
  get ultima(): { snapshot: RecordingSnapshot; recipe: Recipe } | undefined {
    return this.ultimoFinalizado
  }

  /**
   * Espera a gravação corrente terminar.
   *
   * A extensão confirma o `stop` pelo WebSocket; a API espera esse
   * instante para devolver a receita. Sem confirmação no prazo, quem
   * chama decide o que fazer.
   */
  async waitFinished(timeoutMs: number): Promise<{ snapshot: RecordingSnapshot; recipe: Recipe } | undefined> {
    const limite = Date.now() + timeoutMs
    while (Date.now() < limite) {
      if (this.ultimoFinalizado) return this.ultimoFinalizado
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return undefined
  }

  discard(clientId?: string): RecordingSnapshot {
    const dono = this.dono(clientId)
    const snapshot = this.snapshot(clientId)
    this.sessions.delete(dono)
    if (this.corrente === dono) this.corrente = SEM_CLIENTE
    // descartar é jogar fora: a receita da gravação anterior não vale mais
    this.ultimoFinalizado = undefined
    return snapshot
  }

  /** Apaga todas as gravações. */
  reset(): void {
    this.sessions.clear()
    this.corrente = SEM_CLIENTE
  }

  snapshot(clientId?: string): RecordingSnapshot {
    const session = this.session(clientId)
    if (!session) {
      return {
        id: "",
        projectId: undefined,
        status: "idle",
        events: [],
        startedAt: 0,
        updatedAt: 0,
      }
    }
    return {
      id: session.id,
      projectId: session.projectId,
      status: session.status,
      events: [...session.events],
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    }
  }

  get isActive(): boolean {
    for (const session of this.sessions.values()) {
      if (session.status !== "idle") return true
    }
    return false
  }

  /** A gravação desta extensão está ativa? */
  isRecording(clientId: string): boolean {
    const session = this.sessions.get(clientId)
    return session ? session.status !== "idle" : false
  }

  /**
   * Esta extensão é a dona da gravação em andamento?
   *
   * Usado para ignorar comandos de pause/resume/stop que chegam de uma
   * extensão que não começou a gravação.
   */
  belongsTo(clientId: string): boolean {
    return this.isRecording(clientId)
  }

  /** Converte os eventos capturados em passos de receita. */
  toRecipe(events: RecordedEvent[]): Recipe {
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

    for (const event of events) {
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
          flush()
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

  /** Sessão pedida, ou a corrente quando o cliente não é informado. */
  private session(clientId?: string): RecordingSession | undefined {
    return this.sessions.get(clientId ?? this.corrente)
  }

  /**
   * Sessão que recebe os eventos desta extensão.
   *
   * Uma extensão sem gravação própria adota a gravação que não tem dona —
   * é o que acontece quando a gravação começou pela API HTTP e a extensão
   * é a primeira a mandar eventos.
   */
  private sessaoDoEvento(clientId?: string): RecordingSession | undefined {
    if (!clientId) return this.session()
    const propria = this.sessions.get(clientId)
    if (propria) return propria

    const semDono = this.sessions.get(SEM_CLIENTE)
    if (!semDono) return undefined

    this.sessions.delete(SEM_CLIENTE)
    this.sessions.set(clientId, semDono)
    this.corrente = clientId
    return semDono
  }

  /** Chave da sessão pedida, ou da corrente. */
  private dono(clientId?: string): string {
    return clientId ?? this.corrente
  }
}

interface RecordingSession {
  id: string
  projectId: string | undefined
  status: RecordingStatus
  events: RecordedEvent[]
  startedAt: number
  updatedAt: number
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
