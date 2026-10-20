/**
 * Roda toda a suíte end-to-end da extensão em sequência.
 *
 * Cada teste abre um Chrome próprio; sem uma pausa entre eles, os processos
 * se acumulam e a máquina fica sem memória. Este script cuida da limpeza.
 *
 * Uso: node packages/extension/test/e2e-all.mjs [serverUrl]
 */
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"

/**
 * Diretório de perfis só desta execução.
 *
 * Os testes criam o perfil do Chrome em `os.tmpdir()`, que respeita o
 * `TMPDIR`. Dar um diretório exclusivo por execução impede que duas suítes
 * rodando ao mesmo tempo usem o mesmo perfil.
 */
const perfilBase = mkdtempSync(join(tmpdir(), "griver-suite-"))

const TESTES = [
  "verifica-painel",
  "overlay",
  "modal",
  "panel-save",
  "uso-real",
  "erro-gravacao",
]

/** Tempo máximo de um teste antes de ser considerado travado. */
const TEMPO_MAXIMO_MS = 180_000

/**
 * Fecha os Chromes que sobraram de uma execução anterior.
 *
 * Só mata navegador que ninguém mais está usando: um Chrome cujo processo
 * pai já morreu virou órfão e vai segurar memória à toa. Quem ainda tem
 * pai vivo pertence a outra execução — essa fica intacta.
 *
 * Antes isso matava qualquer Chrome com `/griver-` no comando, o que
 * derrubava o navegador das execuções paralelas na mesma máquina.
 */
function limparChrome() {
  let lista
  try {
    lista = execSync("ps -eo pid,ppid,args --no-headers", { encoding: "utf8" })
      .split("\n")
      .map((linha) => linha.trim())
      .filter(Boolean)
      .filter((linha) => /chrom/.test(linha))
      .filter((linha) => /--user-data-dir=\S*griver-/.test(linha))
  } catch {
    return 0
  }

  let mortos = 0
  for (const linha of lista) {
    const [pid, ppid] = linha.split(/\s+/).slice(0, 2).map(Number)
    if (!pid || !ppid) continue
    if (pid === process.pid) continue

    // perfil desta execução: sempre nosso, pode matar
    // perfil de outra execução: só mata se o pai morreu (órfão)
    const nosso = linha.includes(perfilBase)
    if (!nosso && ppid !== 1) continue

    try {
      // mata o grupo inteiro: o navegador e os filhos dele
      execSync(`kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null`, {
        stdio: "ignore",
      })
      mortos++
    } catch {
      // já morreu
    }
  }
  return mortos
}

/**
 * Mata o processo do teste e o Chrome que ele abriu.
 *
 * O teste roda em seu próprio grupo de processos (`detached`), então o grupo
 * inteiro cai junto — inclusive o Chrome órfão que o teste deixou.
 */
function matarGrupo(proc) {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    try {
      process.kill(proc.pid, "SIGKILL")
    } catch {
      // já morreu
    }
  }
}

let falhou = false

for (const nome of TESTES) {
  limparChrome()
  await new Promise((r) => setTimeout(r, 500))

  const caminho = resolve(`packages/extension/test/${nome}.e2e.mjs`)
  const codigo = await new Promise((resolveCode) => {
    const proc = spawn(process.execPath, [caminho, serverUrl], {
      stdio: "inherit",
      detached: true,
      env: { ...process.env, TMPDIR: perfilBase },
    })

    // um teste travado segura o Chrome e o grupo de processos para sempre
    const timer = setTimeout(() => {
      console.log(`  (tempo esgotado: ${nome})`)
      matarGrupo(proc)
    }, TEMPO_MAXIMO_MS)

    proc.on("exit", (code) => {
      clearTimeout(timer)
      resolveCode(code ?? 1)
    })
  })

  if (codigo === 0) {
    console.log(`✓ ${nome}\n`)
  } else {
    console.log(`✗ ${nome} (código ${codigo})\n`)
    falhou = true
  }
}

limparChrome()

try {
  rmSync(perfilBase, { recursive: true, force: true })
} catch {
  //Profiles temporários podem ficar para trás; não é motivo para falhar.
}

if (falhou) {
  console.log("✗ algum teste falhou")
  process.exit(1)
}
console.log("✓ todos os testes passaram")
