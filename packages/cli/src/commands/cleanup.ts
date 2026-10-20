import { encerrarOrfaos, servidoresOrfaos } from "@griver/server/orfaos"

/**
 * Encerra servidores do Griver que ficaram órfãos.
 *
 * Um servidor órfão sobreviveu a quem o started: o shell terminou e o
 * processo ficou sozinho, segurando a porta e a memória. Vários deles juntos
 * chegam a ocupar gigabytes de RAM.
 *
 * Só morre o que não tem dono: um servidor com dono vivo (o shell que o
 * pediu ainda está de pé) fica intacto.
 */
export async function commandCleanup(rest: string[], json: boolean): Promise<number> {
  const orfaos = servidoresOrfaos()
  const vivos = orfaos.filter((processo) => processo.estado !== "Z")

  if (vivos.length === 0) {
    if (json) {
      console.log(JSON.stringify({ encerrados: [] }, null, 2))
    } else {
      console.log("nenhum servidor órfão")
    }
    return 0
  }

  const encerrados = encerrarOrfaos()

  if (json) {
    console.log(
      JSON.stringify(
        {
          encerrados: encerrados.map((processo) => ({
            pid: processo.pid,
            comando: processo.cmdline.slice(0, 120),
          })),
        },
        null,
        2,
      ),
    )
    return 0
  }

  console.log(`servidores órfãos encerrados: ${encerrados.length}`)
  for (const processo of encerrados) {
    console.log(`  ${processo.pid}  ${processo.cmdline.slice(0, 90)}`)
  }
  return 0
}
