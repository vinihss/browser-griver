import type { CompareOp } from "../recipe/schema.js"

/**
 * Escopo de variáveis de uma execução.
 *
 * Os valores são strings simples ou estruturas JSON serializáveis.
 */
export type Scope = Record<string, unknown>
const TEMPLATE = /\{\{\s*([\w.$-]+)\s*\}\}/g

/** Substitui `{{var}}` pelo valor do escopo. Variáveis ausentes viram string vazia. */
export function interpolate(template: string, scope: Scope): string {
  if (!template || !template.includes("{{")) return template
  return template.replace(TEMPLATE, (_match, name: string) => {
    const value = lookup(scope, name)
    return stringify(value)
  })
}

/** Lê uma variável aceitando notação de ponto (`it.price`). */
export function lookup(scope: Scope, path: string): unknown {
  if (path in scope) return scope[path]
  const parts = path.split(".")
  let current: unknown = scope
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Converte qualquer valor para texto legível. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d,.-]/g, "").replace(",", ".")
    const n = Number.parseFloat(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (["true", "1", "yes", "sim", "verdadeiro"].includes(v)) return true
    if (["false", "0", "no", "nao", "falso", ""].includes(v)) return false
    return v.length > 0
  }
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

export function compare(left: unknown, op: CompareOp, right: unknown): boolean {
  switch (op) {
    case "==":
      return looseEquals(left, right)
    case "!=":
      return !looseEquals(left, right)
    case "contains":
      return stringify(left).includes(stringify(right))
    case "matches":
      try {
        return new RegExp(stringify(right)).test(stringify(left))
      } catch {
        return false
      }
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const a = toNumber(left)
      const b = toNumber(right)
      if (a === null || b === null) {
        const sa = stringify(left)
        const sb = stringify(right)
        switch (op) {
          case ">":
            return sa > sb
          case ">=":
            return sa >= sb
          case "<":
            return sa < sb
          default:
            return sa <= sb
        }
      }
      switch (op) {
        case ">":
          return a > b
        case ">=":
          return a >= b
        case "<":
          return a < b
        default:
          return a <= b
      }
    }
  }
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number") {
    const a = toNumber(left)
    const b = toNumber(right)
    if (a !== null && b !== null) return a === b
  }
  if (typeof left === "boolean" || typeof right === "boolean") {
    return toBoolean(left) === toBoolean(right)
  }
  return stringify(left) === stringify(right)
}

/** Cria um escopo filho para iterações de loop, preservando o escopo pai. */
export function childScope(parent: Scope, extra: Record<string, unknown> = {}): Scope {
  return { ...parent, ...extra }
}
