import type { TargetKind } from "./schema.js"

export interface StepInfo {
  type: string
  label: string
  description: string
  /** alvos em que o passo tem implementação */
  targets: TargetKind[]
  /** o passo produz/consome valores do escopo de variáveis */
  produces?: string
  consumes?: string[]
}

export const STEP_CATALOG: StepInfo[] = [
  {
    type: "navigate",
    label: "Navegar",
    description: "Abre uma URL. No alvo os equivale a um scrape da página.",
    targets: ["browser", "os"],
  },
  {
    type: "click",
    label: "Clicar",
    description: "Clica em um elemento. No alvo os usa a ação de clique do Firecrawl.",
    targets: ["browser", "os"],
  },
  {
    type: "fill",
    label: "Preencher",
    description: "Preenche um campo de texto.",
    targets: ["browser", "os"],
  },
  {
    type: "press",
    label: "Pressionar",
    description: "Pressiona uma tecla (Enter, Escape, Tab...).",
    targets: ["browser", "os"],
  },
  {
    type: "select",
    label: "Selecionar",
    description: "Seleciona uma opção em um <select>.",
    targets: ["browser"],
  },
  {
    type: "hover",
    label: "Passar o mouse",
    description: "Move o cursor sobre o elemento (dispara menus flutuantes).",
    targets: ["browser"],
  },
  {
    type: "scrollTo",
    label: "Rolar até",
    description: "Rola a página ou um elemento até uma posição.",
    targets: ["browser"],
  },
  {
    type: "upload",
    label: "Enviar arquivo",
    description: "Envia arquivos para um input de arquivo.",
    targets: ["browser"],
  },
  {
    type: "wait",
    label: "Esperar",
    description: "Pausa fixa em milissegundos.",
    targets: ["browser", "os"],
  },
  {
    type: "waitFor",
    label: "Esperar por elemento",
    description: "Aguarda um elemento aparecer, sumir ou existir.",
    targets: ["browser", "os"],
  },
  {
    type: "extract",
    label: "Extrair",
    description: "Lê o conteúdo de um elemento e salva numa variável.",
    targets: ["browser", "os"],
    produces: "variável",
  },
  {
    type: "assert",
    label: "Verificar",
    description: "Verifica uma condição na página ou sobre uma variável. Falha interrompe a execução.",
    targets: ["browser", "os"],
    consumes: ["variável"],
  },
  {
    type: "set",
    label: "Definir variável",
    description: "Define uma variável no escopo da execução.",
    targets: ["browser", "os"],
    produces: "variável",
  },
  {
    type: "if",
    label: "Condição",
    description: "Executa um bloco de passos se a condição for verdadeira.",
    targets: ["browser", "os"],
    consumes: ["variável"],
  },
  {
    type: "loop",
    label: "Repetir",
    description: "Repete um bloco de passos para cada item de uma lista.",
    targets: ["browser", "os"],
    consumes: ["variável"],
  },
  {
    type: "script",
    label: "Script",
    description: "JavaScript executado no contexto da página.",
    targets: ["browser"],
  },
  {
    type: "screenshot",
    label: "Captura de tela",
    description: "Salva uma imagem da página.",
    targets: ["browser"],
  },
]

export const STEP_BY_TYPE = new Map(STEP_CATALOG.map((s) => [s.type, s]))

export function supportsStep(type: string, target: TargetKind): boolean {
  const info = STEP_BY_TYPE.get(type)
  if (!info) return false
  return info.targets.includes(target)
}

export function stepLabel(type: string): string {
  return STEP_BY_TYPE.get(type)?.label ?? type
}
