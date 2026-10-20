import { openRepository, resolveProjectId } from "./project.js"
import { resolveRecipeId } from "./recipe.js"
import { flag } from "./run.js"

export function commandSchedule(argv: string[], json: boolean): number {
  const [action = "list", ...rest] = argv
  const { repo, close } = openRepository()

  try {
    switch (action) {
      case "list": {
        const schedules = repo.listSchedules()
        if (json) {
          console.log(JSON.stringify(schedules, null, 2))
          return 0
        }
        if (!schedules.length) {
          console.log("Nenhum agendamento. Crie com: griver schedule add <receita> --cron \"*/5 * * * *\"")
          return 0
        }
        console.log("")
        for (const schedule of schedules) {
          const recipe = repo.getRecipe(schedule.recipeId)
          console.log(
            `  ${schedule.id.slice(0, 8)}  ${(recipe?.summary.name ?? schedule.recipeId).padEnd(24)} ${schedule.cron.padEnd(18)} ${schedule.driver}`,
          )
        }
        console.log("")
        return 0
      }

      case "add": {
        const recipeId = resolveRecipeId(repo, rest.find((arg) => !arg.startsWith("--")))
        if (!recipeId) {
          console.error("Receita não encontrada.")
          return 1
        }
        const cron = flag(rest, "--cron")
        if (!cron) {
          console.error('Uso: griver schedule add <receita> --cron "*/5 * * * *"')
          return 1
        }
        const schedule = repo.createSchedule({
          recipeId,
          cron,
          driver: flag(rest, "--driver") ?? "playwright",
        })
        console.log(`Agendamento criado: ${schedule.cron} (${schedule.id})`)
        return 0
      }

      case "rm":
      case "delete": {
        const id = rest[0]
        if (!id) {
          console.error("Uso: griver schedule rm <id>")
          return 1
        }
        const exact = repo.listSchedules().find((schedule) => schedule.id === id)
        const prefix = repo.listSchedules().find((schedule) => schedule.id.startsWith(id))
        const target = exact ?? prefix
        if (!target) {
          console.error("Agendamento não encontrado.")
          return 1
        }
        repo.deleteSchedule(target.id)
        console.log("Agendamento removido.")
        return 0
      }

      default:
        console.error(`Comando desconhecido: schedule ${action}`)
        console.error("Use: list | add | rm")
        return 1
    }
  } finally {
    close()
  }
}

/** Histórico de revisões de uma receita. */
export function commandHistory(argv: string[], json: boolean): number {
  const { repo, close } = openRepository()
  try {
    const recipeId = resolveRecipeId(repo, argv[0])
    if (!recipeId) {
      console.error("Receita não encontrada.")
      return 1
    }
    const revisions = repo.listRevisions(recipeId)
    if (json) {
      console.log(JSON.stringify(revisions, null, 2))
      return 0
    }
    if (!revisions.length) {
      console.log("Nenhuma revisão registrada.")
      return 0
    }
    console.log("")
    for (const revision of revisions) {
      const quando = new Date(revision.createdAt).toLocaleString("pt-BR")
      console.log(`  ${revision.id.slice(0, 8)}  ${quando}  ${revision.label ?? ""}`)
    }
    console.log("")
    console.log("Restaure com: griver recipe restore <receita> <revisão>")
    return 0
  } finally {
    close()
  }
}

export { resolveProjectId }
