import { z } from "zod"

/**
 * Alvo de execução de uma receita.
 *
 * - `browser`: automação real de navegador (Playwright/Puppeteer na aba atual ou headless).
 * - `os`: nível de sistema/serviço web via Firecrawl (scrape/crawl/extract), sem navegador.
 */
export type TargetKind = "browser" | "os"

export const TARGET_KINDS = ["browser", "os"] as const
export const TargetKindSchema = z.enum(TARGET_KINDS)

/**
 * Referência a um elemento na página.
 *
 * `selectors` guarda candidatos em ordem de preferência. O runtime tenta cada um
 * até um resolver, o que torna a receita resistente a mudanças de markup.
 */
export interface TargetRef {
  selectors: string[]
  frames?: string[]
  text?: string
  nth?: number
}

export const TargetRefSchema: z.ZodType<TargetRef> = z.object({
  selectors: z.array(z.string()).min(1),
  frames: z.array(z.string()).optional(),
  text: z.string().optional(),
  nth: z.number().int().optional(),
})

export const COMPARE_OPS = ["==", "!=", ">", ">=", "<", "<=", "contains", "matches"] as const
export type CompareOp = (typeof COMPARE_OPS)[number]

export type Condition =
  | { kind: "compare"; left: string; op: CompareOp; right: string }
  | { kind: "truthy"; value: string }
  | { kind: "and"; conditions: Condition[] }
  | { kind: "or"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("compare"),
      left: z.string(),
      op: z.enum(COMPARE_OPS),
      right: z.string(),
    }),
    z.object({ kind: z.literal("truthy"), value: z.string() }),
    z.object({ kind: z.literal("and"), conditions: z.array(ConditionSchema).min(1) }),
    z.object({ kind: z.literal("or"), conditions: z.array(ConditionSchema).min(1) }),
    z.object({ kind: z.literal("not"), condition: ConditionSchema }),
  ]),
)

export type ExpectKind = "visible" | "hidden" | "text" | "equals" | "contains" | "matches" | "exists"

export interface Expect {
  kind: ExpectKind
  value?: string
}

export const ExpectSchema = z.object({
  kind: z.enum(["visible", "hidden", "text", "equals", "contains", "matches", "exists"]),
  value: z.string().optional(),
})

export type ExtractAttr = "text" | "html" | "href" | "value" | "src" | "count"

export type Step =
  | { id: string; type: "navigate"; url: string }
  | { id: string; type: "click"; target: TargetRef; clickCount?: number; force?: boolean }
  | { id: string; type: "fill"; target: TargetRef; value: string }
  | { id: string; type: "press"; target?: TargetRef; key: string }
  | { id: string; type: "select"; target: TargetRef; value: string }
  | { id: string; type: "hover"; target: TargetRef }
  | { id: string; type: "scrollTo"; target?: TargetRef; position?: "top" | "bottom" | "center" }
  | { id: string; type: "upload"; target: TargetRef; files: string[] }
  | { id: string; type: "wait"; ms: number }
  | { id: string; type: "waitFor"; target: TargetRef; state?: "visible" | "hidden" | "attached"; timeout?: number }
  | { id: string; type: "extract"; target: TargetRef; attr?: ExtractAttr; saveAs: string; many?: boolean }
  | { id: string; type: "assert"; target?: TargetRef; expect: Expect }
  | { id: string; type: "set"; name: string; value: string }
  | { id: string; type: "if"; condition: Condition; then: Step[]; else?: Step[] }
  | { id: string; type: "loop"; over: string; body: Step[]; maxIterations?: number }
  | { id: string; type: "script"; code: string }
  | { id: string; type: "screenshot"; saveAs?: string; fullPage?: boolean }

const base = { id: z.string().min(1) }

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("navigate"), url: z.string().min(1) }),
    z.object({
      ...base,
      type: z.literal("click"),
      target: TargetRefSchema,
      clickCount: z.number().int().min(1).optional(),
      force: z.boolean().optional(),
    }),
    z.object({ ...base, type: z.literal("fill"), target: TargetRefSchema, value: z.string() }),
    z.object({ ...base, type: z.literal("press"), target: TargetRefSchema.optional(), key: z.string().min(1) }),
    z.object({ ...base, type: z.literal("select"), target: TargetRefSchema, value: z.string() }),
    z.object({ ...base, type: z.literal("hover"), target: TargetRefSchema }),
    z.object({
      ...base,
      type: z.literal("scrollTo"),
      target: TargetRefSchema.optional(),
      position: z.enum(["top", "bottom", "center"]).optional(),
    }),
    z.object({ ...base, type: z.literal("upload"), target: TargetRefSchema, files: z.array(z.string()) }),
    z.object({ ...base, type: z.literal("wait"), ms: z.number().int().min(0) }),
    z.object({
      ...base,
      type: z.literal("waitFor"),
      target: TargetRefSchema,
      state: z.enum(["visible", "hidden", "attached"]).optional(),
      timeout: z.number().int().min(0).optional(),
    }),
    z.object({
      ...base,
      type: z.literal("extract"),
      target: TargetRefSchema,
      attr: z.enum(["text", "html", "href", "value", "src", "count"]).optional(),
      saveAs: z.string().min(1),
      many: z.boolean().optional(),
    }),
    z.object({ ...base, type: z.literal("assert"), target: TargetRefSchema.optional(), expect: ExpectSchema }),
    z.object({ ...base, type: z.literal("set"), name: z.string().min(1), value: z.string() }),
    z.object({
      ...base,
      type: z.literal("if"),
      condition: ConditionSchema,
      then: z.array(StepSchema),
      else: z.array(StepSchema).optional(),
    }),
    z.object({
      ...base,
      type: z.literal("loop"),
      over: z.string().min(1),
      body: z.array(StepSchema),
      maxIterations: z.number().int().min(1).optional(),
    }),
    z.object({ ...base, type: z.literal("script"), code: z.string().min(1) }),
    z.object({ ...base, type: z.literal("screenshot"), saveAs: z.string().optional(), fullPage: z.boolean().optional() }),
  ]),
)

export interface Recipe {
  version: 1
  startUrl?: string
  vars?: Record<string, string | number | boolean>
  steps: Step[]
}

export const RecipeSchema: z.ZodType<Recipe> = z.object({
  version: z.literal(1),
  startUrl: z.string().optional(),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  steps: z.array(StepSchema),
})

export function parseRecipe(input: unknown): Recipe {
  return RecipeSchema.parse(input)
}

export function safeParseRecipe(input: unknown) {
  return RecipeSchema.safeParse(input)
}

/** Gera um id de passo curto e legível. */
export function stepId(prefix = "s"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}
