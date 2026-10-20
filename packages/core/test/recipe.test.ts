import { test } from "node:test"
import assert from "node:assert/strict"
import {
  compileToFirecrawl,
  compileToPlaywright,
  parseRecipe,
  recipeJsonSchema,
  safeParseRecipe,
  validateForTarget,
} from "@griver/core"

const base = {
  version: 1 as const,
  startUrl: "https://exemplo.com/login",
  steps: [
    { id: "a", type: "navigate" as const, url: "https://exemplo.com/login" },
    { id: "b", type: "fill" as const, target: { selectors: ["#email"] }, value: "{{user}}" },
    { id: "c", type: "click" as const, target: { selectors: ["button[type=submit]"] } },
    { id: "d", type: "extract" as const, target: { selectors: [".price"] }, saveAs: "preco" },
    {
      id: "e",
      type: "if" as const,
      condition: { kind: "compare" as const, left: "{{preco}}", op: "<" as const, right: "100" },
      then: [{ id: "f", type: "click" as const, target: { selectors: ["#buy"] } }],
    },
    { id: "g", type: "assert" as const, target: { selectors: ["#done"] }, expect: { kind: "visible" as const } },
  ],
}

test("parseia uma receita válida", () => {
  const recipe = parseRecipe(base)
  assert.equal(recipe.steps.length, 6)
  assert.equal(recipe.startUrl, "https://exemplo.com/login")
})

test("rejeita receita com versão desconhecida", () => {
  const result = safeParseRecipe({ ...base, version: 2 })
  assert.equal(result.success, false)
})

test("rejeita passo sem target", () => {
  const result = safeParseRecipe({
    ...base,
    steps: [{ id: "x", type: "click" }],
  })
  assert.equal(result.success, false)
})

test("valida compatibilidade com o alvo browser", () => {
  const issues = validateForTarget(parseRecipe(base), "browser")
  assert.equal(issues.length, 0)
})

test("sinaliza passos sem suporte no alvo os", () => {
  const recipe = parseRecipe({
    ...base,
    steps: [
      ...base.steps,
      { id: "h", type: "select", target: { selectors: ["#plan"] }, value: "pro" },
      { id: "i", type: "screenshot", saveAs: "print.png" },
    ],
  })
  const types = validateForTarget(recipe, "os").map((i) => i.stepType)
  assert.ok(types.includes("select"))
  assert.ok(types.includes("screenshot"))
  assert.ok(!types.includes("navigate"))
})

test("receita só com passos portáteis é válida nos dois alvos", () => {
  const recipe = parseRecipe(base)
  assert.equal(validateForTarget(recipe, "os").length, 0)
  assert.equal(validateForTarget(recipe, "browser").length, 0)
})

test("compila para Playwright com helpers e blocos condicionais", () => {
  const code = compileToPlaywright(parseRecipe(base))
  assert.match(code, /import \{ chromium \} from "playwright"/)
  assert.match(code, /async function pick/)
  assert.match(code, /if \(/)
  assert.match(code, /vars\["preco"\]/)
})

test("compila para Firecrawl agrupando ações", () => {
  const code = compileToFirecrawl(parseRecipe(base))
  assert.match(code, /firecrawl\.scrape/)
  assert.match(code, /"type": "click"/)
  assert.match(code, /"type": "write"/)
})

test("gera JSON Schema utilizável pelo editor", () => {
  const schema = recipeJsonSchema()
  assert.equal(typeof schema, "object")
  assert.ok("properties" in schema)
})
