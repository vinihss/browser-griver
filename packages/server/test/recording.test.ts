import { test } from "node:test"
import assert from "node:assert/strict"
import { RecordingBuffer } from "../src/recording/buffer.js"
import { matches, parseCron } from "../src/scheduler.js"

test("converte eventos em passos de receita", () => {
  const buffer = new RecordingBuffer()
  buffer.start("ext-1", "p1")
  buffer.push({ kind: "navigate", url: "https://exemplo.com/login", ts: 1 }, "ext-1")
  buffer.push({ kind: "input", selectors: ["#nome"], value: "Ana", ts: 2 }, "ext-1")
  buffer.push({ kind: "click", selectors: ["#entrar"], ts: 3 }, "ext-1")
  buffer.push({ kind: "select", selectors: ["#plano"], value: "pro", ts: 4 }, "ext-1")

  const { recipe } = buffer.stop()
  assert.equal(recipe.steps.length, 4)
  assert.equal(recipe.steps[0]?.type, "navigate")
  assert.equal(recipe.steps[1]?.type, "fill")
  assert.equal(recipe.steps[1]?.type === "fill" ? recipe.steps[1].value : "", "Ana")
  assert.equal(recipe.steps[2]?.type, "click")
  assert.equal(recipe.steps[3]?.type, "select")
  assert.equal(recipe.startUrl, "https://exemplo.com/login")
})

test("input e change do mesmo campo viram um único passo", () => {
  const buffer = new RecordingBuffer()
  buffer.start("ext-1", "p1")
  buffer.push({ kind: "navigate", url: "https://exemplo.com", ts: 1 }, "ext-1")
  buffer.push({ kind: "input", selectors: ["#nome"], value: "Ana", ts: 2 }, "ext-1")
  buffer.push({ kind: "change", selectors: ["#nome"], value: "Ana", ts: 3 }, "ext-1")
  buffer.push({ kind: "click", selectors: ["#ok"], ts: 4 }, "ext-1")

  const { recipe } = buffer.stop()
  const fills = recipe.steps.filter((step) => step.type === "fill")
  assert.equal(fills.length, 1)
})

test("pausa ignora eventos", () => {
  const buffer = new RecordingBuffer()
  buffer.start("ext-1", "p1")
  buffer.push({ kind: "click", selectors: ["#a"], ts: 1 }, "ext-1")
  buffer.pause()
  buffer.push({ kind: "click", selectors: ["#b"], ts: 2 }, "ext-1")
  buffer.resume()
  buffer.push({ kind: "click", selectors: ["#c"], ts: 3 }, "ext-1")

  const { recipe } = buffer.stop()
  assert.equal(recipe.steps.length, 2)
  assert.equal(recipe.steps[0]?.type === "click" ? recipe.steps[0].target.selectors[0] : "", "#a")
  assert.equal(recipe.steps[1]?.type === "click" ? recipe.steps[1].target.selectors[0] : "", "#c")
})

test("descartar apaga a gravação", () => {
  const buffer = new RecordingBuffer()
  buffer.start("ext-1", "p1")
  buffer.push({ kind: "click", selectors: ["#a"], ts: 1 }, "ext-1")
  buffer.discard()
  assert.equal(buffer.isActive, false)
  assert.equal(buffer.snapshot().events.length, 0)
})

test("interpreta expressões cron", () => {
  const fields = parseCron("*/5 * * * *")
  assert.ok(fields)
  assert.deepEqual(fields.minute, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])

  const lista = parseCron("0,30 8-17 * * 1-5")
  assert.ok(lista)
  assert.deepEqual(lista.hour, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual(lista.dayOfWeek, [1, 2, 3, 4, 5])

  assert.equal(parseCron("invalido"), undefined)
  assert.equal(parseCron("* * *"), undefined)
})

test("compara o instante com a expressão", () => {
  const fields = parseCron("30 14 * * *")!
  const dentro = new Date(2026, 0, 1, 14, 30, 0)
  const fora = new Date(2026, 0, 1, 14, 31, 0)
  assert.equal(matches(fields, dentro), true)
  assert.equal(matches(fields, fora), false)
})
