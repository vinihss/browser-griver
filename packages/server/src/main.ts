import { runServer } from "./server-runner.js"

/**
 * Ponto de entrada executável do servidor.
 *
 * `index.ts` é a biblioteca (exporta `startServer`); este arquivo é o
 * programa que sobe o servidor de fato.
 */
runServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
