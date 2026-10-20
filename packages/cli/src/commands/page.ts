/**
 * Operação da aba do navegador pela linha de comando.
 *
 * As mesmas ações que o assistente tem como ferramentas: inspecionar a
 * aba, clicar, preencher e capturar a tela. Tudo passa pelo servidor
 * local — é ele que fala com a extensão.
 */
import { writeFileSync } from "node:fs"
import { abrirOps, explicarErro } from "../ops.js"

export async function commandPage(argv: string[], json: boolean): Promise<number> {
  const [acao = "context", ...resto] = argv
  const ops = abrirOps()

  try {
    switch (acao) {
      case "context": {
        const contexto = await ops.pageContext()
        if (json) {
          console.log(JSON.stringify(contexto, null, 2))
          return 0
        }
        console.log(`  ${contexto.title}`)
        console.log(`  ${contexto.url}`)
        const elementos = contexto.elements ?? []
        console.log(`  ${elementos.length} elemento(s) interativo(s)`)
        for (const elemento of elementos.slice(0, 20)) {
          const item = elemento as { tag?: string; text?: string; selectors?: string[] }
          const rotulo = item.text?.trim() || item.selectors?.[0] || ""
          console.log(`    ${item.tag ?? "?"}  ${rotulo}`)
        }
        return 0
      }

      case "click": {
        const seletores = resto.filter((arg) => !arg.startsWith("--"))
        if (!seletores.length) {
          console.error("Uso: griver page click <seletor> [outro seletor ...]")
          return 1
        }
        const texto = flag(resto, "--text")
        const resultado = await ops.pageClick(
          texto ? { selectors: seletores, text: texto } : { selectors: seletores },
        )
        if (json) {
          console.log(JSON.stringify(resultado, null, 2))
        } else {
          console.log("Clicado.")
        }
        return 0
      }

      case "fill": {
        const [seletor, ...valor] = resto.filter((arg) => !arg.startsWith("--"))
        if (!seletor || !valor.length) {
          console.error("Uso: griver page fill <seletor> <valor>")
          return 1
        }
        const resultado = await ops.pageFill({ selectors: [seletor] }, valor.join(" "))
        if (json) {
          console.log(JSON.stringify(resultado, null, 2))
        } else {
          console.log("Preenchido.")
        }
        return 0
      }

      case "screenshot": {
        const destino = flag(resto, "--out")
        const captura = await ops.pageScreenshot()
        const dataUrl = (captura as { dataUrl?: string }).dataUrl
        if (!dataUrl) {
          console.error("A extensão não devolveu a imagem.")
          return 1
        }
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "")
        if (destino) {
          writeFileSync(destino, Buffer.from(base64, "base64"))
          console.log(`Captura escrita em ${destino}`)
        } else {
          console.log(dataUrl)
        }
        return 0
      }

      default:
        console.error(`Ação de página desconhecida: ${acao}`)
        console.error("Use: context, click, fill ou screenshot")
        return 1
    }
  } catch (error) {
    console.error(explicarErro(error))
    return 1
  }
}

function flag(args: string[], name: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`))
  if (prefixed) return prefixed.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index !== -1 && args[index + 1] && !args[index + 1]!.startsWith("--")) return args[index + 1]
  return undefined
}
