/**
 * Gravação de receita pela linha de comando.
 *
 * A mesma gravação que o painel faz: o comando diz ao servidor para
 * comandar a extensão, a extensão captura os eventos da aba e o servidor
 * monta a receita. No fim, a receita pronta é impressa — ou salva em
 * arquivo, para o `griver recipe set` usar.
 */
import { writeFileSync } from "node:fs"
import { abrirOps, explicarErro } from "../ops.js"

export async function commandRecord(argv: string[], json: boolean): Promise<number> {
  const [acao = "state", ...resto] = argv
  const ops = abrirOps()

  try {
    switch (acao) {
      case "state": {
        const estado = await ops.recordingState()
        if (json) {
          console.log(JSON.stringify(estado, null, 2))
          return 0
        }
        console.log(`  gravação: ${estado.status}  (${estado.events.length} evento(s))`)
        return 0
      }

      case "start": {
        const projeto = flag(resto, "--project")
        const resultado = await ops.recordStart(projeto)
        if (!resultado.commanded) {
          console.error(
            "nenhuma extensão conectada — abra o Chrome com a extensão do Griver carregada",
          )
          return 1
        }
        console.log("Gravando. Interaja com a página e rode `griver record stop` quando terminar.")
        return 0
      }

      case "pause": {
        const resultado = await ops.recordPause()
        console.log(`Gravação ${resultado.snapshot.status}.`)
        return 0
      }

      case "resume": {
        const resultado = await ops.recordResume()
        console.log(`Gravação ${resultado.snapshot.status}.`)
        return 0
      }

      case "discard": {
        const resultado = await ops.recordDiscard()
        console.log(`Gravação ${resultado.snapshot.status}.`)
        return 0
      }

      case "stop": {
        const resultado = await ops.recordStop()
        const receita = resultado.recipe
        const destino = flag(resto, "--out")
        if (!receita) {
          console.error("A gravação não produziu passos.")
          return 1
        }
        if (destino) {
          writeFileSync(destino, JSON.stringify(receita, null, 2), "utf8")
          console.log(`Receita gravada em ${destino} (${receita.steps.length} passos)`)
        } else if (json) {
          console.log(JSON.stringify(receita, null, 2))
        } else {
          console.log(`\n  ${receita.steps.length} passos gravados:\n`)
          for (const passo of receita.steps) {
            // o passo é uma união: nem todo passo tem alvo nem url
            const detalhe = passo as { target?: { selectors?: string[] }; url?: string }
            const alvo = detalhe.target?.selectors?.[0] ?? detalhe.url ?? ""
            console.log(`    ${passo.type} ${alvo}`)
          }
          console.log("\nSalve com: griver recipe set <id> --file <arquivo.json>")
        }
        return 0
      }

      default:
        console.error(`Ação de gravação desconhecida: ${acao}`)
        console.error("Use: state, start, pause, resume, stop ou discard")
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
