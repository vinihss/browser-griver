import { readFileSync, writeFileSync } from "node:fs"
import {
  compileToFirecrawl,
  compileToPlaywright,
  parseRecipe,
  safeParseRecipe,
  validateForTarget,
  type TargetKind,
} from "@griver/core"
import { openRepository, resolveProjectId } from "./project.js"
import { diffLines, renderDiff } from "../diff.js"

export function commandRecipe(argv: string[], json: boolean): number {
  const [action = "list", ...rest] = argv
  const { repo, close } = openRepository()

  try {
    switch (action) {
      case "list": {
        const recipes = repo.listRecipes()
        if (json) {
          console.log(JSON.stringify(recipes, null, 2))
          return 0
        }
        if (!recipes.length) {
          console.log("Nenhuma receita ainda.")
          return 0
        }
        console.log("")
        for (const recipe of recipes) {
          console.log(
            `  ${recipe.id.slice(0, 8)}  ${recipe.name.padEnd(26)} [${recipe.target.padEnd(7)}] ${String(recipe.stepCount ?? 0).padStart(3)} passos`,
          )
        }
        console.log("")
        return 0
      }

      case "new": {
        const name = rest[0]
        if (!name) {
          console.error("Uso: griver recipe new <nome> [--project <id>] [--target browser|os]")
          return 1
        }
        const projectFlag = flag(rest, "--project")
        const projectId = resolveProjectId(repo, projectFlag) ?? repo.listProjects()[0]?.id
        if (!projectId) {
          console.error("Nenhum projeto encontrado. Crie um com: griver project create <nome>")
          return 1
        }
        const target = (flag(rest, "--target") ?? "browser") as TargetKind
        const recipe = {
          version: 1 as const,
          steps: [
            { id: "s1", type: "navigate" as const, url: "https://exemplo.com" },
          ],
        }
        const created = repo.createRecipe({ projectId, name, target, recipe })
        if (json) {
          console.log(JSON.stringify(created, null, 2))
        } else {
          console.log(`Receita criada: ${created.name} (${created.id})`)
        }
        return 0
      }

      case "show": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const found = repo.getRecipe(id)!
        if (json) {
          console.log(JSON.stringify(found, null, 2))
          return 0
        }
        console.log(`\n  ${found.summary.name}  (${found.summary.id})  [${found.summary.target}]`)
        console.log(`  projeto: ${found.summary.projectId}\n`)
        console.log(JSON.stringify(found.body, null, 2))
        console.log("")
        return 0
      }

      case "export": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const found = repo.getRecipe(id)!
        const target = (flag(rest, "--target") ?? found.summary.target) as TargetKind
        const outputPath = flag(rest, "--out")

        const code =
          target === "os" ? compileToFirecrawl(found.body) : compileToPlaywright(found.body)

        if (outputPath) {
          writeFileSync(outputPath, code, "utf8")
          console.log(`Código escrito em ${outputPath}`)
        } else {
          console.log(code)
        }
        return 0
      }

      case "validate": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const found = repo.getRecipe(id)!
        const target = (flag(rest, "--target") ?? found.summary.target) as TargetKind
        const issues = validateForTarget(found.body, target)
        if (json) {
          console.log(JSON.stringify(issues, null, 2))
          return issues.some((issue) => issue.severity === "error") ? 1 : 0
        }
        if (!issues.length) {
          console.log(`Receita válida para o alvo "${target}".`)
          return 0
        }
        for (const issue of issues) {
          console.log(`  ${issue.severity === "error" ? "✗" : "!"} ${issue.path}: ${issue.message}`)
        }
        return issues.some((issue) => issue.severity === "error") ? 1 : 0
      }

      case "history": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const revisions = repo.listRevisions(id)
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
        console.log("Compare com: griver recipe diff <receita> <revisão>")
        return 0
      }

      case "diff": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const revisionId = rest[1]
        if (!revisionId) {
          console.error("Uso: griver recipe diff <receita> <revisão>")
          return 1
        }
        const revision = repo.listRevisions(id).find((item) => item.id.startsWith(revisionId))
        if (!revision) {
          console.error("Revisão não encontrada.")
          return 1
        }
        const found = repo.getRecipe(id)!
        const before = repo.getRevisionBody(revision.id)
        if (!before) {
          console.error("Revisão não encontrada.")
          return 1
        }
        const lines = diffLines(
          JSON.stringify(before, null, 2).split("\n"),
          JSON.stringify(found.body, null, 2).split("\n"),
        )
        if (json) {
          console.log(JSON.stringify(lines, null, 2))
          return 0
        }
        console.log("")
        console.log(renderDiff(lines))
        console.log("")
        return 0
      }

      case "restore": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const revisionId = rest[1]
        if (!revisionId) {
          console.error("Uso: griver recipe restore <receita> <revisão>")
          return 1
        }
        const revision = repo.listRevisions(id).find((item) => item.id.startsWith(revisionId))
        if (!revision) {
          console.error("Revisão não encontrada.")
          return 1
        }
        const body = repo.getRevisionBody(revision.id)
        if (!body) {
          console.error("Revisão não encontrada.")
          return 1
        }
        repo.updateRecipe(id, { recipe: body })
        console.log("Receita restaurada.")
        return 0
      }

      case "rm":
      case "delete": {
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        repo.deleteRecipe(id)
        console.log(`Receita removida: ${id}`)
        return 0
      }

      case "set": {
        // griver recipe set <id> --file receita.json
        const id = resolveRecipeId(repo, rest[0])
        if (!id) {
          console.error("Receita não encontrada.")
          return 1
        }
        const file = flag(rest, "--file")
        if (!file) {
          console.error("Uso: griver recipe set <id> --file <arquivo.json>")
          return 1
        }
        const parsed = safeParseRecipe(JSON.parse(readFileSync(file, "utf8")))
        if (!parsed.success) {
          console.error("Arquivo inválido:", parsed.error.issues)
          return 1
        }
        repo.updateRecipe(id, { recipe: parsed.data })
        console.log("Receita atualizada.")
        return 0
      }

      default:
        console.error(`Comando desconhecido: recipe ${action}`)
        console.error("Use: list | new | show | export | validate | set | rm")
        return 1
    }
  } finally {
    close()
  }
}

function flag(args: string[], name: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`))
  if (prefixed) return prefixed.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index !== -1 && args[index + 1] && !args[index + 1]!.startsWith("--")) return args[index + 1]
  return undefined
}

export function resolveRecipeId(repo: ReturnType<typeof openRepository>["repo"], input: string | undefined) {
  if (!input) return undefined
  const recipes = repo.listRecipes()
  const exact = recipes.find((recipe) => recipe.id === input)
  if (exact) return exact.id
  const prefix = recipes.find((recipe) => recipe.id.startsWith(input))
  if (prefix) return prefix.id
  return recipes.find((recipe) => recipe.name === input)?.id
}

export { parseRecipe }
