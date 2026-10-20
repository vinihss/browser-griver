import { runRecipe, type Driver, type TargetKind } from "@griver/core"
import { createPlaywrightDriver } from "@griver/server/drivers/playwright"
import { createFirecrawlDriver } from "@griver/server/drivers/firecrawl"
import { openRepository, resolveProjectId } from "./project.js"
import { resolveRecipeId } from "./recipe.js"
import { abrirOps, explicarErro } from "../ops.js"

export interface RunOptions {
  target?: TargetKind
  driver?: string
  headed?: boolean
  cdpUrl?: string
  vars?: Record<string, unknown>
  json?: boolean
}

export async function commandRun(argv: string[], json: boolean): Promise<number> {
  const [primeiro = "", ...resto] = argv

  // `run list` e `run cancel` olham o servidor; `run <receita>` roda local
  if (primeiro === "list") return await listarExecucoes(json)
  if (primeiro === "cancel") return await cancelarExecucao(resto, json)

  const id = primeiro
  const target = flag(argv, "--target") as TargetKind | undefined
  const driver = flag(argv, "--driver")
  const headed = argv.includes("--headed")
  const cdpUrl = flag(argv, "--cdp")
  const vars = parseVars(argv)

  const { repo, close } = openRepository()
  const recipeId = resolveRecipeId(repo, id)
  if (!recipeId) {
    console.error(`Receita não encontrada: ${id || "(vazio)"}`)
    close()
    return 1
  }

  const found = repo.getRecipe(recipeId)!
  const effectiveTarget = target ?? found.summary.target
  const effectiveDriver = driver ?? (effectiveTarget === "os" ? "firecrawl" : "playwright")

  let driverInstance: Driver
  try {
    if (effectiveTarget === "os" || effectiveDriver === "firecrawl") {
      driverInstance = await createFirecrawlDriver({ apiKey: process.env.FIRECRAWL_API_KEY })
    } else if (effectiveDriver === "cdp") {
      driverInstance = await createPlaywrightDriver({
        cdpUrl: cdpUrl ?? process.env.GRIVER_CDP_URL ?? "http://127.0.0.1:9222",
      })
    } else {
      driverInstance = await createPlaywrightDriver({ headed })
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    close()
    return 1
  }

  const events: unknown[] = []
  const result = await runRecipe(found.body, driverInstance, {
    scope: vars,
    onStep: (event) => {
      events.push(event)
      if (!json) {
        const mark = event.status === "ok" ? "✓" : event.status === "error" ? "✗" : "·"
        const detail = event.error ? ` — ${event.error}` : ""
        console.log(`  ${mark} ${event.path} ${event.type}${detail}`)
      }
    },
  })

  await driverInstance.close().catch(() => undefined)
  close()

  if (json) {
    console.log(
      JSON.stringify(
        {
          recipe: found.summary.id,
          target: effectiveTarget,
          driver: effectiveDriver,
          status: result.status,
          error: result.error?.message,
          scope: result.scope,
          steps: result.steps,
        },
        null,
        2,
      ),
    )
  } else {
    console.log("")
    console.log(
      result.status === "ok"
        ? `Concluído. Variáveis: ${Object.keys(result.scope).filter((k) => !k.startsWith("__")).join(", ") || "(nenhuma)"}`
        : `Falhou: ${result.error?.message ?? "erro desconhecido"}`,
    )
  }

  return result.status === "ok" ? 0 : 1
}

/** Lista as execuções recentes — as que o servidor registrou. */
async function listarExecucoes(json: boolean): Promise<number> {
  const ops = abrirOps()
  try {
    const { runs } = await ops.listRuns()
    if (json) {
      console.log(JSON.stringify(runs, null, 2))
      return 0
    }
    if (!runs.length) {
      console.log("Nenhuma execução ainda.")
      return 0
    }
    console.log("")
    for (const run of runs) {
      const duracao = run.endedAt ? ` ${run.endedAt - run.startedAt}ms` : ""
      console.log(
        `  ${run.id.slice(0, 8)}  ${run.status.padEnd(8)} ${(run.recipeName ?? run.recipeId).padEnd(24)} [${run.driver}]${duracao}`,
      )
    }
    console.log("")
    return 0
  } catch (error) {
    console.error(explicarErro(error))
    return 1
  }
}

/** Cancela uma execução em andamento. */
async function cancelarExecucao(argv: string[], json: boolean): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("--")) ?? ""
  if (!id) {
    console.error("Uso: griver run cancel <id da execução>")
    return 1
  }
  const ops = abrirOps()
  try {
    await ops.cancelRun(id)
    if (json) {
      console.log(JSON.stringify({ ok: true, cancelled: id }, null, 2))
    } else {
      console.log(`Execução ${id} cancelada.`)
    }
    return 0
  } catch (error) {
    console.error(explicarErro(error))
    return 1
  }
}

export function flag(args: string[], name: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`))
  if (prefixed) return prefixed.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index !== -1 && args[index + 1] && !args[index + 1]!.startsWith("--")) return args[index + 1]
  return undefined
}

export function parseVars(args: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const arg of args) {
    if (!arg.startsWith("--var=")) continue
    const body = arg.slice("--var=".length)
    const index = body.indexOf("=")
    if (index === -1) continue
    const key = body.slice(0, index)
    const value = body.slice(index + 1)
    vars[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
  }
  return vars
}

export { resolveProjectId }
