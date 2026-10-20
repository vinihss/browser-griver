/**
 * Diff de linhas simples (LCS).
 *
 * Usado para comparar a receita atual com uma revisão anterior.
 */
export interface DiffLine {
  kind: "igual" | "add" | "remove"
  text: string
}

export function diffLines(antes: string[], depois: string[]): DiffLine[] {
  const tabela: number[][] = Array.from({ length: antes.length + 1 }, () =>
    new Array<number>(depois.length + 1).fill(0),
  )

  for (let i = antes.length - 1; i >= 0; i--) {
    for (let j = depois.length - 1; j >= 0; j--) {
      tabela[i]![j] =
        antes[i] === depois[j]
          ? tabela[i + 1]![j + 1]! + 1
          : Math.max(tabela[i + 1]![j]!, tabela[i]![j + 1]!)
    }
  }

  const resultado: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < antes.length && j < depois.length) {
    if (antes[i] === depois[j]) {
      resultado.push({ kind: "igual", text: antes[i]! })
      i++
      j++
    } else if (tabela[i + 1]![j]! >= tabela[i]![j + 1]!) {
      resultado.push({ kind: "remove", text: antes[i]! })
      i++
    } else {
      resultado.push({ kind: "add", text: depois[j]! })
      j++
    }
  }
  while (i < antes.length) resultado.push({ kind: "remove", text: antes[i++]! })
  while (j < depois.length) resultado.push({ kind: "add", text: depois[j++]! })

  return resultado
}

/** Renderiza o diff no terminal. */
export function renderDiff(lines: DiffLine[]): string {
  return lines
    .map((line) => {
      if (line.kind === "igual") return `  ${line.text}`
      if (line.kind === "add") return `+ ${line.text}`
      return `- ${line.text}`
    })
    .join("\n")
}
