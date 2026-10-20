import { parseArgs } from "node:util"
import { runServer } from "@griver/server/server-runner"
import { resolveDataDir } from "../shared.js"

export async function commandServe(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "data-dir": { type: "string" },
    },
    strict: false,
  })

  const dataDir = resolveDataDir(values["data-dir"] as string | undefined)
  await runServer({
    dataDir,
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host as string } : {}),
  })

  // o processo fica vivo até o servidor receber SIGINT/SIGTERM
  await new Promise(() => {})
  return 0
}
