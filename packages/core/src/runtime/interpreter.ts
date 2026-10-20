import type { Condition, Recipe, Step } from "../recipe/schema.js"
import type { Driver } from "./driver.js"
import { compare, interpolate, lookup, Scope, stringify, toBoolean } from "./vars.js"

export type StepStatus = "running" | "ok" | "error" | "skipped"

export interface StepEvent {
  stepId: string
  type: string
  /** caminho do passo dentro da receita, ex.: `steps[2].then[0]` */
  path: string
  depth: number
  status: StepStatus
  startedAt: number
  endedAt?: number
  error?: string
  value?: unknown
}

export interface RunOptions {
  scope?: Scope
  signal?: AbortSignal
  onStep?: (event: StepEvent) => void
  /** pausa máxima por passo, em ms */
  defaultTimeout?: number
}

export interface RunError {
  message: string
  stepId?: string
  path?: string
  stack?: string
}

export interface RunResult {
  status: "ok" | "error" | "aborted"
  scope: Scope
  error?: RunError
  steps: StepEvent[]
}

export class AbortedError extends Error {
  constructor() {
    super("execução cancelada")
    this.name = "AbortedError"
  }
}

/**
 * Executa uma receita contra um `Driver`.
 *
 * O interpretador é agnóstico de motor: a mesma receita roda na aba do
 * navegador (via extensão) ou no Playwright headless (via servidor).
 */
export async function runRecipe(
  recipe: Recipe,
  driver: Driver,
  options: RunOptions = {},
): Promise<RunResult> {
  const scope: Scope = { ...(recipe.vars ?? {}), ...(options.scope ?? {}) }
  const events: StepEvent[] = []

  const emit = (event: StepEvent) => {
    events.push(event)
    options.onStep?.(event)
  }

  const abort = () => {
    throw new AbortedError()
  }

  const execute = async (steps: Step[], path: string, depth: number): Promise<void> => {
    for (let index = 0; index < steps.length; index++) {
      if (options.signal?.aborted) abort()
      const step = steps[index]!
      const stepPath = `${path}[${index}]`
      await executeStep(step, stepPath, depth)
    }
  }

  const executeStep = async (step: Step, path: string, depth: number): Promise<void> => {
    const startedAt = Date.now()
    emit({ stepId: step.id, type: step.type, path, depth, status: "running", startedAt })

    const finish = (status: StepStatus, extra?: Partial<StepEvent>) => {
      emit({
        stepId: step.id,
        type: step.type,
        path,
        depth,
        status,
        startedAt,
        endedAt: Date.now(),
        ...extra,
      })
    }

    try {
      const value = await dispatch(step, scope, path, depth)
      finish("ok", value === undefined ? undefined : { value })
    } catch (error) {
      if (error instanceof AbortedError) {
        finish("error", { error: error.message })
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      finish("error", { error: message })
      throw error
    }
  }

  const dispatch = async (
    step: Step,
    scope: Scope,
    path: string,
    depth: number,
  ): Promise<unknown> => {
    switch (step.type) {
      case "navigate": {
        const url = interpolate(step.url, scope)
        await driver.navigate(url)
        return url
      }
      case "click": {
        await driver.click(step.target, { clickCount: step.clickCount, force: step.force })
        return undefined
      }
      case "fill": {
        const value = interpolate(step.value, scope)
        await driver.fill(step.target, value)
        return value
      }
      case "press": {
        await driver.press(step.target, interpolate(step.key, scope))
        return undefined
      }
      case "select": {
        const value = interpolate(step.value, scope)
        await driver.select(step.target, value)
        return value
      }
      case "hover": {
        await driver.hover(step.target)
        return undefined
      }
      case "scrollTo": {
        await driver.scrollTo(step.target, step.position)
        return undefined
      }
      case "upload": {
        await driver.upload(
          step.target,
          step.files.map((f) => interpolate(f, scope)),
        )
        return undefined
      }
      case "wait": {
        await driver.wait(step.ms)
        return undefined
      }
      case "waitFor": {
        await driver.waitFor(step.target, step.state, step.timeout ?? options.defaultTimeout)
        return undefined
      }
      case "extract": {
        const result = await driver.extract(step.target, step.attr, step.many === true)
        scope[step.saveAs] = result.value
        return result.value
      }
      case "assert": {
        await driver.assert(step.target, step.expect, scope)
        return undefined
      }
      case "set": {
        const value = interpolate(step.value, scope)
        scope[step.name] = value
        return value
      }
      case "if": {
        const taken = evaluateCondition(step.condition, scope)
        const branch = taken ? step.then : (step.else ?? [])
        await execute(branch, `${path}.${taken ? "then" : "else"}`, depth + 1)
        return taken ? "then" : "else"
      }
      case "loop": {
        const source = lookup(scope, step.over)
        const items = Array.isArray(source) ? source : source === undefined ? [] : [source]
        const limit = step.maxIterations ?? items.length
        const count = Math.min(items.length, limit)
        for (let i = 0; i < count; i++) {
          if (options.signal?.aborted) abort()
          const item = items[i]
          const inner: Scope = { ...scope }
          inner["it"] = item
          inner["index"] = i
          if (item && typeof item === "object") {
            for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
              inner[k] = v
            }
          }
          const saved = { ...scope }
          Object.assign(scope, inner)
          await execute(step.body, `${path}.body[${i}]`, depth + 1)
          Object.assign(scope, saved)
        }
        return count
      }
      case "script": {
        const code = interpolate(step.code, scope)
        return await driver.eval(code)
      }
      case "screenshot": {
        const result = await driver.screenshot({ fullPage: step.fullPage })
        if (step.saveAs) scope[step.saveAs] = result.path ?? result.base64
        return result.path ?? undefined
      }
    }
  }

  try {
    if (recipe.startUrl && !scope["__started"]) {
      scope["__started"] = true
      await driver.navigate(interpolate(recipe.startUrl, scope))
    }
    await execute(recipe.steps, "steps", 0)
    return { status: "ok", scope, steps: events }
  } catch (error) {
    if (error instanceof AbortedError) {
      return { status: "aborted", scope, error: { message: error.message }, steps: events }
    }
    const message = error instanceof Error ? error.message : String(error)
    const failed = [...events].reverse().find((e) => e.status === "error")
    return {
      status: "error",
      scope,
      error: {
        message,
        stepId: failed?.stepId,
        path: failed?.path,
        stack: error instanceof Error ? error.stack : undefined,
      },
      steps: events,
    }
  }
}

/** Avalia uma condição contra o escopo de variáveis. */
export function evaluateCondition(condition: Condition, scope: Scope): boolean {
  switch (condition.kind) {
    case "compare": {
      const left = interpolate(condition.left, scope)
      const right = interpolate(condition.right, scope)
      return compare(left, condition.op, right)
    }
    case "truthy":
      return toBoolean(interpolate(condition.value, scope))
    case "and":
      return condition.conditions.every((c) => evaluateCondition(c, scope))
    case "or":
      return condition.conditions.some((c) => evaluateCondition(c, scope))
    case "not":
      return !evaluateCondition(condition.condition, scope)
  }
}

/** Texto legível de uma condição, para exibição na interface. */
export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case "compare":
      return `${condition.left} ${condition.op} ${condition.right}`
    case "truthy":
      return `${condition.value} é verdadeiro`
    case "and":
      return condition.conditions.map(describeCondition).join(" e ")
    case "or":
      return condition.conditions.map(describeCondition).join(" ou ")
    case "not":
      return `não (${describeCondition(condition.condition)})`
  }
}

export { stringify }
