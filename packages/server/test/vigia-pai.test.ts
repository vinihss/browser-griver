import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { guardiaoDaCadeia, vigiaGuardiao, esperarPortaLivre, portaLivre } from "../src/server-runner.js"

/** Espera a condição ficar verdadeira, sem travar o teste se nunca ficar. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

test("o servidor se encerra quando o guardião morre", async () => {
  let morreu = false
  let vivo = true

  const timer = vigiaGuardiao(
    4242,
    () => {
      morreu = true
    },
    { intervaloMs: 20, vivo: () => vivo },
  )

  try {
    // o guardião ainda está vivo: nada acontece
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(morreu, false, "o servidor não pode morrer com o guardião vivo")

    // o guardião morre: o servidor vai junto
    vivo = false
    const avisou = await waitFor(() => morreu)
    assert.equal(avisou, true, "o servidor deve se encerrar quando o guardião morre")
  } finally {
    clearInterval(timer)
  }
})

test("sem guardião a vigia não encerra nada", async () => {
  let morreu = false

  const timer = vigiaGuardiao(
    undefined,
    () => {
      morreu = true
    },
    { intervaloMs: 20, vivo: () => false },
  )

  try {
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(morreu, false, "contêiner e systemd não contam como morte")
  } finally {
    clearInterval(timer)
  }
})

test("a vigia não impede o processo de encerrar", () => {
  const timer = vigiaGuardiao(4242, () => {}, { intervaloMs: 20, vivo: () => true })
  // um timer com unref não segura o event loop: o processo encerra sozinho
  assert.equal((timer as { hasRef?: () => boolean }).hasRef?.() ?? false, false)
  clearInterval(timer)
})

test("o guardião é o líder da sessão, e não o pai direto", () => {
  const guardiao = guardiaoDaCadeia()
  // neste processo de teste o guardião existe e não é o próprio processo
  assert.notEqual(guardiao, undefined)
  assert.notEqual(guardiao, process.pid)
  assert.notEqual(guardiao, process.ppid)
  assert.ok((guardiao ?? 0) > 1, "o guardião tem de ser um processo de verdade")
})

test("o guardião de um processo vivo está vivo", () => {
  const guardiao = guardiaoDaCadeia()
  if (guardiao === undefined) return
  assert.doesNotThrow(() => process.kill(guardiao, 0))
})

test("a porta livre é reconhecida", async () => {
  const porta = 47311
  assert.equal(await portaLivre(porta, "127.0.0.1"), true, "ninguém escutando: a porta está livre")
})

test("a porta ocupada não é esperada como livre", async () => {
  const porta = 47312
  const ocupado = createServer()
  await new Promise<void>((resolver) => ocupado.listen(porta, "127.0.0.1", resolver))

  try {
    assert.equal(await portaLivre(porta, "127.0.0.1"), false, "com alguém escutando, a porta não está livre")
  } finally {
    await new Promise<void>((resolver) => ocupado.close(() => resolver()))
  }
})

test("esperar a porta livre dá tempo de quem ainda segura o socket", async () => {
  const porta = 47313
  const ocupado = createServer()
  await new Promise<void>((resolver) => ocupado.listen(porta, "127.0.0.1", resolver))

  // o servidor novo só sobe se a porta estiver livre: EADDRINUSE mata ele
  const inicio = Date.now()
  const liberada = await esperarPortaLivre(porta, "127.0.0.1", 300)
  assert.equal(liberada, false, "com o socket preso, a espera precisa terminar sem liberar")

  await new Promise<void>((resolver) => ocupado.close(() => resolver()))
  assert.equal(await esperarPortaLivre(porta, "127.0.0.1", 1000), true, "soltou a porta: a espera libera")
  assert.ok(Date.now() - inicio >= 300, "a espera respeita o prazo")
})
