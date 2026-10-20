import { z } from "zod"
import { RecipeSchema } from "./schema.js"

/**
 * Deriva o JSON Schema da receita a partir do schema Zod.
 *
 * Usado pela extensão para Offering autocomplete e validação no editor.
 */
export function recipeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(RecipeSchema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  }) as Record<string, unknown>
}

/** Palavras-chave sugeridas no editor, por contexto. */
export const EDITOR_KEYWORDS = [
  "navigate",
  "click",
  "fill",
  "press",
  "select",
  "hover",
  "scrollTo",
  "upload",
  "wait",
  "waitFor",
  "extract",
  "assert",
  "set",
  "if",
  "loop",
  "script",
  "screenshot",
]
