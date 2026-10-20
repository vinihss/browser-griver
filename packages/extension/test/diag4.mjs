import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")
const userDataDir = mkdtempSync(join(tmpdir(), "griver-diag4-"))
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-first-run"],
})
let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })
const panel = await context.newPage()
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await panel.waitForTimeout(1000)

const info = await panel.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".panel-header button")).map((b) => ({
    title: b.title,
    aria: b.getAttribute("aria-label"),
    txt: b.textContent?.trim(),
  }))
  return { btns, sel: Boolean(document.querySelector('.panel-header button[title="Add New Script"]')) }
})
console.log("botões:", JSON.stringify(info.btns, null, 1))
console.log("seletor acha:", info.sel)

await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Add New Script"]')?.click()
})
await panel.waitForTimeout(600)
const modal = await panel.evaluate(() => ({
  modal: Boolean(document.querySelector(".modal")),
  body: document.querySelector(".body")?.innerHTML?.slice(0, 200),
}))
console.log("modal:", JSON.stringify(modal))
await context.close()
