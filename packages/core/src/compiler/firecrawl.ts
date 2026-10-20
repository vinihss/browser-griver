import type { Condition, Recipe, Step } from "../recipe/schema.js"

/**
 * Gera um script Firecrawl autocontido a partir de uma receita.
 *
 * Passos de interação viram `actions` do endpoint de scrape; os de leitura
 * viram `formats` (attributes/json) e os de controle viram JavaScript comum.
 */
export function compileToFirecrawl(recipe: Recipe): string {
  const lines: string[] = []
  const scope = new Set<string>()

  lines.push(`import { firecrawl } from "@mendable/firecrawl-js"`)
  lines.push(``)
  lines.push(`const vars: Record<string, any> = ${JSON.stringify(recipe.vars ?? {}, null, 2)}`)
  lines.push(``)
  lines.push(`async function main() {`)

  const steps = recipe.steps
  let index = 0
  while (index < steps.length) {
    const step = steps[index]!
    if (isActionStep(step)) {
      // agrupa ações consecutivas em um único scrape
      const actions: unknown[] = []
      let url = recipe.startUrl ?? ""
      while (index < steps.length && isActionStep(steps[index]!)) {
        const current = steps[index]!
        if (current.type === "navigate") url = current.url
        else actions.push(firecrawlAction(current))
        index++
      }
      lines.push(`  const result = await firecrawl.scrape(${JSON.stringify(url)}, {`)
      lines.push(`    formats: ["markdown"],`)
      if (actions.length) {
        lines.push(`    actions: ${JSON.stringify(actions, null, 6).split("\n").join("\n    ")},`)
      }
      lines.push(`  })`)
      lines.push(`  vars["page"] = result.data?.markdown ?? ""`)
      lines.push(``)
      continue
    }
    emitStep(lines, step, "  ", scope)
    index++
  }

  lines.push(``)
  lines.push(`  console.log(JSON.stringify(vars, null, 2))`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`main().catch((error) => {`)
  lines.push(`  console.error(error)`)
  lines.push(`  process.exit(1)`)
  lines.push(`})`)
  lines.push(``)

  return lines.join("\n")
}

function isActionStep(step: Step): boolean {
  return ["navigate", "click", "fill", "press", "wait"].includes(step.type)
}

function firecrawlAction(step: Step): Record<string, unknown> {
  switch (step.type) {
    case "click":
      return { type: "click", selector: step.target.selectors[0] }
    case "fill":
      return { type: "write", text: step.value }
    case "press":
      return { type: "press", key: step.key }
    case "wait":
      return { type: "wait", milliseconds: step.ms }
    default:
      return { type: "scrape" }
  }
}

function emitStep(lines: string[], step: Step, indent: string, scope: Set<string>): void {
  switch (step.type) {
    case "extract": {
      const selector = step.target.selectors[0] ?? ""
      const attribute = step.attr && step.attr !== "text" ? step.attr : undefined
      lines.push(`${indent}const extracted = await extract(${JSON.stringify(selector)}, ${JSON.stringify(attribute ?? null)})`)
      lines.push(`${indent}vars[${JSON.stringify(step.saveAs)}] = extracted`)
      scope.add(step.saveAs)
      break
    }
    case "assert": {
      const expr = assertExpression(step)
      lines.push(`${indent}if (!(${expr})) throw new Error(${JSON.stringify(`verificação falhou: ${step.expect.kind}`)})`)
      break
    }
    case "set":
      lines.push(`${indent}vars[${JSON.stringify(step.name)}] = ${JSON.stringify(step.value)}`)
      scope.add(step.name)
      break
    case "if": {
      lines.push(`${indent}if (${conditionExpression(step.condition)}) {`)
      for (const inner of step.then) emitStep(lines, inner, indent + "  ", scope)
      if (step.else?.length) {
        lines.push(`${indent}} else {`)
        for (const inner of step.else) emitStep(lines, inner, indent + "  ", scope)
      }
      lines.push(`${indent}}`)
      break
    }
    case "loop": {
      const limit = step.maxIterations ? `.slice(0, ${step.maxIterations})` : ""
      lines.push(`${indent}for (const item of (Array.isArray(vars[${JSON.stringify(step.over)}]) ? vars[${JSON.stringify(step.over)}] : [])${limit}) {`)
      lines.push(`${indent}  vars["it"] = item`)
      for (const inner of step.body) emitStep(lines, inner, indent + "  ", scope)
      lines.push(`${indent}}`)
      break
    }
    case "waitFor":
      lines.push(`${indent}await new Promise((resolve) => setTimeout(resolve, ${step.timeout ?? 30000}))`)
      break
    case "script":
      lines.push(`${indent}// script: ${step.code.replace(/\n/g, " ")}`)
      break
    default:
      lines.push(`${indent}// passo "${step.type}" não aplicável no alvo os`)
      break
  }
}

function assertExpression(step: Extract<Step, { type: "assert" }>): string {
  const kind = step.expect.kind
  if (kind === "visible" || kind === "exists") {
    return `String(vars["page"] ?? "").includes(${JSON.stringify(step.target?.selectors?.[0] ?? "")})`
  }
  if (kind === "hidden") {
    return `!String(vars["page"] ?? "").includes(${JSON.stringify(step.target?.selectors?.[0] ?? "")})`
  }
  if (kind === "contains") {
    return `String(vars["page"] ?? "").includes(${JSON.stringify(step.expect.value ?? "")})`
  }
  if (kind === "matches") {
    return `new RegExp(${JSON.stringify(step.expect.value ?? "")}).test(String(vars["page"] ?? ""))`
  }
  return "true"
}

function conditionExpression(condition: Condition): string {
  switch (condition.kind) {
    case "compare": {
      const left = `resolve(${JSON.stringify(condition.left)})`
      const right = `resolve(${JSON.stringify(condition.right)})`
      switch (condition.op) {
        case "==":
          return `${left} === ${right}`
        case "!=":
          return `${left} !== ${right}`
        case "contains":
          return `${left}.includes(${right})`
        case "matches":
          return `new RegExp(${right}).test(${left})`
        case ">":
          return `Number(${left}) > Number(${right})`
        case ">=":
          return `Number(${left}) >= Number(${right})`
        case "<":
          return `Number(${left}) < Number(${right})`
        case "<=":
          return `Number(${left}) <= Number(${right})`
      }
    }
    case "truthy":
      return `Boolean(vars[${JSON.stringify(condition.value)}])`
    case "and":
      return condition.conditions.map(conditionExpression).join(" && ")
    case "or":
      return condition.conditions.map(conditionExpression).join(" || ")
    case "not":
      return `!(${conditionExpression(condition.condition)})`
  }
}

/** Utilitário anexado ao script gerado para resolver templates e extrair valores. */
export const FIRECRAWL_HELPERS = `
function resolve(template: string): string {
  return String(template).replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (_m, key) => String(vars[key] ?? ""))
}

async function extract(selector: string, attribute: string | null): Promise<string | string[]> {
  const html = String(vars["page"] ?? "")
  const matches = [...html.matchAll(new RegExp(\`<[^>]*class="[^"]*\${selector}[^"]*"[^>]*>([^<]*)<\`, "gi"))].map((m) => m[1] ?? "")
  const value = attribute ? matches : matches
  return value.length === 1 ? value[0]! : value
}
`
