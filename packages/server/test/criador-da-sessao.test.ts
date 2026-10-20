import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

/** A raiz do repositório: os scripts filhos importam o código daqui. */
const RAIZ = resolve(import.meta.dirname, "../../..")
const SERVER_RUNNER = join(RAIZ, "packages/server/src/server-runner.ts")

/**
 * O filho: um servidor de mentira que usa a vigia de verdade.
 *
 * Ele roda detached (sua própria sessão) e diz quem é o criador da sessão.
 * Quando esse criador morre, a vigia tem de levá-lo junto.
 */
const FILHO = `
import { writeFileSync } from "node:fs"
import { criadorDaSessao, vigiaGuardiao } from ${JSON.stringify(SERVER_RUNNER)}

const criador = criadorDaSessao()
console.log("vigia:" + (criador ?? "nenhum"))

// avisa que já achou o dono: a partir daqui o criador pode sair
const aviso = process.env.GRIVER_TESTE_AVISO
if (aviso) writeFileSync(aviso, String(criador ?? "nenhum"))

vigiaGuardiao(criador, () => {
  console.log("MORREU")
  process.exit(0)
}, { intervaloMs: 100 })

// ninguém morreu: o teste reprova em vez de travar para sempre
setTimeout(() => {
  console.log("NINGUEM MORREU")
  process.exit(2)
}, 20000)
`

/**
 * O criador: sobe o filho detached e morre na hora.
 *
 * O pid do criador vai por herança (`GRIVER_CRIADOR`). Não há outro jeito:
 * quando o pai morre, o kernel reparenta o filho para o init e o `/proc`
 * já não sabe de quem ele era — quem o started precisa dizer.
 */
const CRIADOR = `
import { spawn } from "node:child_process"

const filho = spawn(process.execPath, ["--import", "tsx", process.argv[2]], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, GRIVER_CRIADOR: String(process.pid) },
})
filho.unref()
console.log("criador:" + process.pid)
`

/**
 * Roda o script e espera o fim da conversa.
 *
 * Não dá para esperar o criador sair: ele morre no mesmo instante em que
 * sobe o filho, e o filho ainda tem muito o que dizer. O que fecha a conversa
 * é o pipe: ele só acaba quando ninguém segura mais a ponta da escrita.
 */
function rodar(
  comando: string[],
  aviso: string,
  timeoutMs = 30000,
): Promise<{ saida: string; codigo: number | null }> {
  return new Promise((resolver) => {
    const proc = spawn(process.execPath, ["--import", "tsx", comando[0]!, ...comando.slice(1)], {
      cwd: RAIZ,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GRIVER_TESTE_AVISO: aviso },
    })
    let saida = ""
    let resolvido = false
    const terminar = (codigo: number | null) => {
      if (resolvido) return
      resolvido = true
      clearTimeout(timer)
      resolver({ saida, codigo })
    }
    proc.stdout?.on("data", (d) => {
      saida += d.toString()
      // o filho falou: a vigia respondeu
      if (/MORREU|NINGUEM MORREU/.test(saida)) terminar(null)
    })
    proc.stderr?.on("data", (d) => (saida += d.toString()))
    // o pipe fecha quando ninguém segura mais a ponta da escrita: o criador
    // já saiu, o filho ainda tem o que dizer
    proc.stdout?.on("end", () => terminar(null))
    proc.on("exit", () => {
      // o criador saiu: o filho pode ainda estar falando
    })
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      terminar(null)
    }, timeoutMs)
  })
}

test("o servidor detached morre com quem o started", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "griver-criador-"))
  const arquivoFilho = join(pasta, "filho.ts")
  const arquivoCriador = join(pasta, "criador.ts")
  const aviso = join(pasta, "aviso")
  writeFileSync(arquivoFilho, FILHO)
  writeFileSync(arquivoCriador, CRIADOR)

  const { saida } = await rodar([arquivoCriador, arquivoFilho], aviso)

  // o filho viu o criador (o processo que o started), não o init
  assert.match(saida, /vigia:\d+/, `o filho tem de achar o criador da sessão: ${saida}`)
  assert.doesNotMatch(saida, /vigia:nenhum/, "o filho detached tem um criador para vigiar")

  // e caiu junto com ele
  assert.match(saida, /MORREU/, `o servidor tem de morrer com o criador: ${saida}`)
  assert.doesNotMatch(saida, /NINGUEM MORREU/, "a vigia não disparou")
})

/**
 * O criador que fica vivo: o pid vai pelo `/proc`.
 *
 * Sem herança, quem started o servidor é achado pelo `/proc`: o pai do
 * líder da sessão, quando veio de outra sessão. Funciona enquanto o criador
 * estiver de pé — o que não é pouca coisa: um shell que pede o servidor e
 * continua vivo é o caso comum.
 */
const CRIADOR_VIVO = `
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

// sem herança: o filho tem de achar o criador pelo /proc
const env = { ...process.env }
delete env.GRIVER_CRIADOR

const filho = spawn(process.execPath, ["--import", "tsx", process.argv[2]], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env,
})
filho.unref()
console.log("criador:" + process.pid)

// fica vivo até o filho achar o dono. Com um prazo fixo, um arranque lento
// do filho (o tsx carrega o pacote inteiro) encontra o criador já morto —
// e o /proc, para um órfão, só sabe dizer que o pai virou o init.
const aviso = env.GRIVER_TESTE_AVISO
const limite = Date.now() + 60000
const esperar = async () => {
  while (!existsSync(aviso) && Date.now() < limite) {
    await new Promise((resolver) => setTimeout(resolver, 50))
  }
  console.log("criador:pronto")
}
void esperar()
`

test("o servidor acha o criador pelo /proc quando ele ainda está vivo", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "griver-criador-"))
  const arquivoFilho = join(pasta, "filho.ts")
  const arquivoCriador = join(pasta, "criador.ts")
  const aviso = join(pasta, "aviso")
  writeFileSync(arquivoFilho, FILHO)
  writeFileSync(arquivoCriador, CRIADOR_VIVO)

  const { saida } = await rodar([arquivoCriador, arquivoFilho], aviso)

  const criador = saida.match(/criador:(\d+)/)?.[1]
  assert.ok(criador, `o criador tem de dizer quem é: ${saida}`)

  // o vigia é o criador, e não o init
  assert.match(saida, new RegExp(`vigia:${criador}\\b`), `o filho tem de vigiar o criador: ${saida}`)
  assert.doesNotMatch(saida, /vigia:nenhum/, "o filho achou o criador pelo /proc")

  // e caiu junto com ele
  assert.match(saida, /MORREU/, `o servidor tem de morrer com o criador: ${saida}`)
  assert.doesNotMatch(saida, /NINGUEM MORREU/, "a vigia não disparou")
})
