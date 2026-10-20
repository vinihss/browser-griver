/**
 * Superfície sem dependências do zod.
 *
 * O service worker e o content script importam daqui para manter o bundle
 * enxuto — a validação com zod só é necessária no painel e no servidor.
 */
export * from "./vars.js"
export * from "./driver.js"
export * from "./interpreter.js"

// tipos do esquema (somente tipos — o zod não entra no bundle)
export type {
  Condition,
  Expect,
  ExtractAttr,
  Recipe,
  Step,
  TargetKind,
  TargetRef,
} from "../recipe/schema.js"
