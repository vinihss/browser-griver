import { supportsStep } from "./steps.js"
import type { Recipe, Step, TargetKind } from "./schema.js"

export interface ValidationIssue {
  path: string
  stepId: string
  stepType: string
  message: string
  severity: "error" | "warning"
}

/**
 * Verifica se todos os passos da receita podem ser executados no alvo pedido.
 * Percorre recursivamente os blocos `if`/`loop`.
 */
export function validateForTarget(recipe: Recipe, target: TargetKind): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const walk = (steps: Step[], path: string) => {
    steps.forEach((step, index) => {
      const stepPath = `${path}[${index}]`
      if (!supportsStep(step.type, target)) {
        issues.push({
          path: stepPath,
          stepId: step.id,
          stepType: step.type,
          message: `O passo "${step.type}" não é suportado no alvo "${target}".`,
          severity: "error",
        })
      }
      if (step.type === "if") {
        walk(step.then, `${stepPath}.then`)
        if (step.else) walk(step.else, `${stepPath}.else`)
      }
      if (step.type === "loop") {
        walk(step.body, `${stepPath}.body`)
      }
    })
  }

  walk(recipe.steps, "steps")
  return issues
}

/** Passos que o alvo não suporta — usado para avisar antes de salvar. */
export function unsupportedSteps(recipe: Recipe, target: TargetKind): ValidationIssue[] {
  return validateForTarget(recipe, target).filter((i) => i.severity === "error")
}

/** Lista de tipos de passo presentes na receita (inclui blocos aninhados). */
export function collectStepTypes(steps: Step[]): string[] {
  const out = new Set<string>()
  const walk = (list: Step[]) => {
    for (const step of list) {
      out.add(step.type)
      if (step.type === "if") {
        walk(step.then)
        if (step.else) walk(step.else)
      }
      if (step.type === "loop") walk(step.body)
    }
  }
  walk(steps)
  return [...out]
}
