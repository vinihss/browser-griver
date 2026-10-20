import { openDatabase } from "@griver/server/db"
import { Repository } from "@griver/server/db/repo"
import { resolveDataDir } from "../shared.js"

export function openRepository(dataDir?: string): { repo: Repository; close: () => void } {
  const dir = resolveDataDir(dataDir)
  const db = openDatabase(`${dir}/griver.db`)
  return { repo: new Repository(db), close: () => db.close() }
}

export function commandProject(argv: string[], json: boolean): number {
  const [action = "list", ...rest] = argv
  const { repo, close } = openRepository()

  try {
    switch (action) {
      case "list": {
        const projects = repo.listProjects()
        if (json) {
          console.log(JSON.stringify(projects, null, 2))
          return 0
        }
        if (!projects.length) {
          console.log("Nenhum projeto ainda. Crie com: griver project create <nome>")
          return 0
        }
        console.log("")
        for (const project of projects) {
          console.log(
            `  ${project.id.slice(0, 8)}  ${project.name.padEnd(28)} ${String(project.recipeCount ?? 0).padStart(3)} receita(s)`,
          )
        }
        console.log("")
        return 0
      }

      case "create": {
        const name = rest.filter((arg) => !arg.startsWith("--")).join(" ").trim()
        if (!name) {
          console.error("Uso: griver project create <nome>")
          return 1
        }
        const project = repo.createProject(name)
        if (json) {
          console.log(JSON.stringify(project, null, 2))
        } else {
          console.log(`Projeto criado: ${project.name} (${project.id})`)
        }
        return 0
      }

      case "show": {
        const id = resolveProjectId(repo, rest[0])
        if (!id) {
          console.error("Projeto não encontrado.")
          return 1
        }
        const project = repo.getProject(id)
        const recipes = repo.listRecipes(id)
        if (json) {
          console.log(JSON.stringify({ project, recipes }, null, 2))
          return 0
        }
        console.log(`\n  ${project?.name}  (${project?.id})`)
        if (project?.description) console.log(`  ${project.description}`)
        console.log(`\n  Receitas:`)
        for (const recipe of recipes) {
          console.log(`    ${recipe.id.slice(0, 8)}  ${recipe.name.padEnd(26)} [${recipe.target}] ${recipe.stepCount ?? 0} passos`)
        }
        console.log("")
        return 0
      }

      case "rm":
      case "delete": {
        const id = resolveProjectId(repo, rest[0])
        if (!id) {
          console.error("Projeto não encontrado.")
          return 1
        }
        repo.deleteProject(id)
        console.log(`Projeto removido: ${id}`)
        return 0
      }

      default:
        console.error(`Comando desconhecido: project ${action}`)
        console.error("Use: list | create | show | rm")
        return 1
    }
  } finally {
    close()
  }
}

/** Aceita id completo, id abreviado ou nome do projeto. */
export function resolveProjectId(repo: Repository, input: string | undefined): string | undefined {
  if (!input) return undefined
  const projects = repo.listProjects()
  const exact = projects.find((project) => project.id === input)
  if (exact) return exact.id
  const prefix = projects.find((project) => project.id.startsWith(input))
  if (prefix) return prefix.id
  return projects.find((project) => project.name === input)?.id
}
