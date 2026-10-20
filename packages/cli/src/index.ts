#!/usr/bin/env node
import { parseGlobal } from "./shared.js"

const HELP = `
griver — automatizador de browser local

Uso: griver <comando> [opções]

Comandos:
  serve                     sobe o servidor local (HTTP + WebSocket) para a extensão
  doctor                    verifica Node, Playwright, Chrome, Firecrawl e OpenCode
  cleanup                   encerra servidores que ficaram órfãos
  project list              lista os projetos
  project create <nome>     cria um projeto
  project show [id|nome]    mostra um projeto e suas receitas
  project rm [id|nome]      remove um projeto
  recipe list               lista as receitas
  recipe new <nome>         cria uma receita (--target browser|os)
  recipe show <id|nome>     mostra a receita em JSON
  recipe export <id|nome>   exporta código Playwright ou Firecrawl (--target, --out)
  recipe validate <id>      valida a receita para o alvo
  recipe set <id> --file    substitui o corpo da receita por um JSON
  recipe history <id>       mostra as revisões da receita
  recipe diff <id> <rev>    compara a receita atual com uma revisão
  recipe restore <id> <rev> restaura uma revisão
  recipe rm <id|nome>       remove uma receita
  schedule list             lista os agendamentos
  schedule add <receita> --cron "*/5 * * * *"
  schedule rm <id>          remove um agendamento
  history <id>              atalho para o histórico de revisões
  run <id|nome>             executa uma receita (--target, --driver, --headed, --var k=v)
  chat "<mensagem>"         conversa com o assistente de IA do OpenCode

Opções globais:
  --data-dir <pasta>        pasta de dados (padrão ./data)
  --json                    saída em JSON
  --help                    esta ajuda
`

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const { values, positionals } = parseGlobal(argv)
  const json = values.json === true
  const command = positionals[0]
  const rest = positionals.slice(1)

  // propaga a pasta de dados para os subcomandos
  if (typeof values.dataDir === "string") {
    process.env.GRIVER_DATA_DIR = values.dataDir
  }

  if (!command || values.help === true || command === "help") {
    console.log(HELP)
    return 0
  }

  switch (command) {
    case "serve": {
      const { commandServe } = await import("./commands/serve.js")
      return await commandServe(rest)
    }
    case "doctor": {
      const { commandDoctor } = await import("./commands/doctor.js")
      return await commandDoctor(rest)
    }
    case "cleanup": {
      const { commandCleanup } = await import("./commands/cleanup.js")
      return await commandCleanup(rest, json)
    }
    case "project": {
      const { commandProject } = await import("./commands/project.js")
      return commandProject(rest, json)
    }
    case "recipe": {
      const { commandRecipe } = await import("./commands/recipe.js")
      return commandRecipe(rest, json)
    }
    case "schedule": {
      const { commandSchedule } = await import("./commands/schedule.js")
      return commandSchedule(rest, json)
    }
    case "history": {
      const { commandHistory } = await import("./commands/schedule.js")
      return commandHistory(rest, json)
    }
    case "run": {
      const { commandRun } = await import("./commands/run.js")
      return await commandRun(rest, json)
    }
    case "chat": {
      const { commandChat } = await import("./commands/chat.js")
      return await commandChat(rest, json)
    }
    default:
      console.error(`Comando desconhecido: ${command}`)
      console.log(HELP)
      return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
