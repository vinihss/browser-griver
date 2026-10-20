import { OpenCodeClient } from "@griver/server/opencode/client"
import { ChatBridge } from "@griver/server/opencode/bridge"
import { openDatabase } from "@griver/server/db"
import { Repository } from "@griver/server/db/repo"
import { resolveDataDir, opencodeConfigDir } from "../shared.js"

/**
 * Chat direto com o OpenCode, sem extensão no meio.
 *
 * A mesma ponte usada pelo painel da extensão, porém com saída no terminal.
 */
export async function commandChat(argv: string[], json: boolean): Promise<number> {
  const message = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim()
  if (!message) {
    console.error("Uso: griver chat \"sua mensagem\"")
    return 1
  }

  const dataDir = resolveDataDir()
  const db = openDatabase(`${dataDir}/griver.db`)
  const repo = new Repository(db)

  const client = new OpenCodeClient(opencodeConfigDir())
  const endpoint = await client.discover()
  if (!endpoint) {
    console.error("Serviço local do OpenCode não está rodando. Inicie com: opencode")
    db.close()
    return 1
  }

  let printed = ""
  const streamed = new Set<string>()

  const bridge = new ChatBridge(client, repo, {
    onMessage: (sessionId, message) => {
      if (message.role !== "assistant") return

      if (message.partial) {
        // fragmento de streaming: imprime na hora e marca o id
        printed += message.text
        streamed.add(message.id)
        if (!json) process.stdout.write(message.text)
        return
      }

      // mensagem final: se nada foi transmitido para este id, imprime agora
      if (!streamed.has(message.id)) {
        printed += message.text
        if (!json) process.stdout.write(message.text)
      } else {
        // substitui o trecho transmitido pelo texto definitivo
        printed = printed.slice(0, printed.length - message.text.length)
        printed += message.text
      }
    },
    onTool: (sessionId, toolName, state) => {
      if (!json) process.stderr.write(`\n  [tool] ${toolName} (${state})\n`)
    },
    onError: (sessionId, message) => {
      if (!json) process.stderr.write(`\n  [erro] ${message}\n`)
    },
  })

  await bridge.ensureSubscribed()
  const session = await bridge.createSession({ title: "CLI" })
  if (!session.opencodeSessionId) {
    console.error("Não foi possível criar a sessão no OpenCode.")
    db.close()
    return 1
  }

  await bridge.send(session.id, message)

  // espera a execução começar
  const startDeadline = Date.now() + 20_000
  while (Date.now() < startDeadline && !bridge.isExecuting(session.id)) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  // e depois termina
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (printed && !bridge.isExecuting(session.id)) break
  }

  if (json) {
    console.log(JSON.stringify({ session: session.id, text: printed }, null, 2))
  } else {
    console.log("")
  }

  db.close()
  return 0
}
