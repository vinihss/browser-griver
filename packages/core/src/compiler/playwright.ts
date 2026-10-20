import type { Condition, Recipe, Step } from "../recipe/schema.js"
import { userAgentDe } from "../runtime/browser.js"
import { interpolate } from "../runtime/vars.js"

/**
 * Gera um script Playwright autocontido a partir de uma receita.
 *
 * O código gerado é meant para rodar fora do Griver (export) — o servidor usa
 * o interpretador, não este arquivo.
 */
export function compileToPlaywright(recipe: Recipe, options: { headed?: boolean; startUrl?: string } = {}): string {
  const lines: string[] = []
  const scope = new Set<string>()

  lines.push(`import { chromium } from "playwright"`)
  lines.push(``)
  lines.push(`const vars: Record<string, any> = ${JSON.stringify(recipe.vars ?? {}, null, 2)}`)
  lines.push(``)
  lines.push(`async function pick(page: any, selectors: string[]): Promise<any> {`)
  lines.push(`  for (const selector of selectors) {`)
  lines.push(`    const locator = page.locator(selector).first()`)
  lines.push(`    if (await locator.count()) return locator`)
  lines.push(`  }`)
  lines.push(`  throw new Error(\`nenhum seletor casou: \${selectors.join(", ")}\`)`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`/** Repete a busca ate o elemento aparecer (ou sumir) dentro do limite. */`)
  lines.push(`async function waitForEl(page: any, selectors: string[], state: string, timeout: number): Promise<void> {`)
  lines.push(`  const deadline = Date.now() + timeout`)
  lines.push(`  let ultimoErro = ""`)
  lines.push(`  for (;;) {`)
  lines.push(`    for (const selector of selectors) {`)
  lines.push(`      const locator = page.locator(selector).first()`)
  lines.push(`      if (await locator.count()) {`)
  lines.push(`        try {`)
  lines.push(`          await locator.waitFor({ state, timeout: Math.max(1, deadline - Date.now()) })`)
  lines.push(`          return`)
  lines.push(`        } catch (error) {`)
  lines.push(`          ultimoErro = String(error)`)
  lines.push(`        }`)
  lines.push(`      }`)
  lines.push(`    }`)
  lines.push(`    if (Date.now() >= deadline) {`)
  lines.push(`      throw new Error(\`elemento nao ficou "\${state}" em \${timeout}ms\`)`)
  lines.push(`    }`)
  lines.push(`    await page.waitForTimeout(150)`)
  lines.push(`  }`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`async function main() {`)
  lines.push(
    `  const browser = await chromium.launch({ headless: ${options.headed ? "false" : "true"} })`,
  )
  const userAgent = userAgentDe(options.headed)
  lines.push(
    `  const context = await browser.newContext(${userAgent ? `{ userAgent: ${JSON.stringify(userAgent)} }` : "{}"})`,
  )
  lines.push(`  const page = await context.newPage()`)
  lines.push(``)

  const startUrl = options.startUrl ?? recipe.startUrl
  if (startUrl) {
    lines.push(`  await page.goto(${JSON.stringify(startUrl)})`)
    lines.push(``)
  }

  emitSteps(lines, recipe.steps, "  ", scope)

  lines.push(``)
  lines.push(`  console.log(JSON.stringify(vars, null, 2))`)
  lines.push(`  await browser.close()`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`main().catch((error) => {`)
  lines.push(`  console.error(error)`)
  lines.push(`  process.exit(1)`)
  lines.push(`})`)
  lines.push(``)

  return lines.join("\n")
}

function emitSteps(lines: string[], steps: Step[], indent: string, scope: Set<string>): void {
  for (const step of steps) {
    emitStep(lines, step, indent, scope)
  }
}

function emitStep(lines: string[], step: Step, indent: string, scope: Set<string>): void {
  switch (step.type) {
    case "navigate":
      lines.push(`${indent}await page.goto(${JSON.stringify(step.url)})`)
      break
    case "click": {
      lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).click({`)
      lines.push(`${indent}  clickCount: ${step.clickCount ?? 1},`)
      lines.push(`${indent}  force: ${step.force ?? false},`)
      lines.push(`${indent})`)
      break
    }
    case "fill":
      lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).fill(${JSON.stringify(step.value)})`)
      break
    case "press":
      if (step.target) {
        lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).press(${JSON.stringify(step.key)})`)
      } else {
        lines.push(`${indent}await page.keyboard.press(${JSON.stringify(step.key)})`)
      }
      break
    case "select":
      lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).selectOption(${JSON.stringify(step.value)})`)
      break
    case "hover":
      lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).hover()`)
      break
    case "scrollTo": {
      if (step.target) {
        lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).scrollIntoViewIfNeeded()`)
      } else {
        lines.push(`${indent}await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }))`)
      }
      break
    }
    case "upload":
      lines.push(`${indent}await (await pick(page, ${JSON.stringify(step.target.selectors)})).setInputFiles(${JSON.stringify(step.files)})`)
      break
    case "wait":
      lines.push(`${indent}await page.waitForTimeout(${step.ms})`)
      break
    case "waitFor": {
      const state = step.state ?? "visible"
      lines.push(
        `${indent}await waitForEl(page, ${JSON.stringify(step.target.selectors)}, ${JSON.stringify(state)}, ${step.timeout ?? 30000})`,
      )
      break
    }
    case "extract": {
      const expr = extractExpression(step.target.selectors, step.attr, step.many === true)
      lines.push(`${indent}vars[${JSON.stringify(step.saveAs)}] = ${expr}`)
      scope.add(step.saveAs)
      break
    }
    case "assert": {
      const expr = assertExpression(step.target?.selectors, step.expect.kind, step.expect.value)
      lines.push(`${indent}if (!(${expr})) throw new Error(${JSON.stringify(`verificação falhou: ${step.expect.kind}`)})`)
      break
    }
    case "set":
      lines.push(`${indent}vars[${JSON.stringify(step.name)}] = ${JSON.stringify(step.value)}`)
      scope.add(step.name)
      break
    case "if": {
      lines.push(`${indent}if (${conditionExpression(step.condition)}) {`)
      emitSteps(lines, step.then, indent + "  ", scope)
      if (step.else?.length) {
        lines.push(`${indent}} else {`)
        emitSteps(lines, step.else, indent + "  ", scope)
      }
      lines.push(`${indent}}`)
      break
    }
    case "loop": {
      const limit = step.maxIterations ? `.slice(0, ${step.maxIterations})` : ""
      lines.push(`${indent}for (const item of (Array.isArray(vars[${JSON.stringify(step.over)}]) ? vars[${JSON.stringify(step.over)}] : [])${limit}) {`)
      lines.push(`${indent}  vars["it"] = item`)
      emitSteps(lines, step.body, indent + "  ", scope)
      lines.push(`${indent}}`)
      break
    }
    case "script":
      lines.push(`${indent}await page.evaluate(${JSON.stringify(step.code)})`)
      break
    case "screenshot":
      lines.push(`${indent}await page.screenshot({ path: ${JSON.stringify(step.saveAs ?? "screenshot.png")}, fullPage: ${step.fullPage ?? false} })`)
      break
  }
}

function extractExpression(selectors: string[], attr: string | undefined, many: boolean): string {
  const locator = `(await pick(page, ${JSON.stringify(selectors)}))`
  if (many) {
    const collection = `page.locator(${JSON.stringify(selectors[0]!)}).all()`
    if (attr === "text") return `(await ${collection}).map((el: any) => el.innerText())`
    if (attr === "html") return `(await ${collection}).map((el: any) => el.innerHTML())`
    if (attr === "href") return `(await ${collection}).map((el: any) => el.getAttribute("href"))`
    if (attr === "value") return `(await ${collection}).map((el: any) => (el as any).value)`
    if (attr === "src") return `(await ${collection}).map((el: any) => el.getAttribute("src"))`
    return `(await ${collection}).map((el: any) => el.innerText())`
  }
  if (attr === "html") return `await ${locator}.innerHTML()`
  if (attr === "href") return `await ${locator}.getAttribute("href")`
  if (attr === "value") return `await ${locator}.inputValue()`
  if (attr === "src") return `await ${locator}.getAttribute("src")`
  return `await ${locator}.innerText()`
}

function assertExpression(selectors: string[] | undefined, kind: string, value?: string): string {
  switch (kind) {
    case "visible":
      return selectors ? `await (await pick(page, ${JSON.stringify(selectors)})).isVisible()` : "true"
    case "hidden":
      return selectors ? `!(await (await pick(page, ${JSON.stringify(selectors)})).isVisible())` : "true"
    case "exists":
      return selectors ? `(await page.locator(${JSON.stringify(selectors[0]!)}).count()) > 0` : "true"
    case "text":
      return selectors ? `(await (await pick(page, ${JSON.stringify(selectors)})).innerText()).trim() === ${JSON.stringify(value ?? "")}` : "true"
    case "equals":
      return `String(vars[${JSON.stringify(value ?? "")}]) === ""`
    case "contains":
      return `String(vars[${JSON.stringify(value ?? "")}] ?? "").includes("")`
    case "matches":
      return `new RegExp("").test(String(vars[${JSON.stringify(value ?? "")}] ?? ""))`
    default:
      return "true"
  }
}

function conditionExpression(condition: Condition): string {
  switch (condition.kind) {
    case "compare": {
      const left = `String(${JSON.stringify(condition.left)}).replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (m, k) => String(vars[k] ?? ""))`
      const right = `String(${JSON.stringify(condition.right)}).replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (m, k) => String(vars[k] ?? ""))`
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
    case "truthy": {
      const value = interpolate(condition.value, {})
      return `Boolean(vars[${JSON.stringify(value)}])`
    }
    case "and":
      return condition.conditions.map(conditionExpression).join(" && ")
    case "or":
      return condition.conditions.map(conditionExpression).join(" || ")
    case "not":
      return `!(${conditionExpression(condition.condition)})`
  }
}
