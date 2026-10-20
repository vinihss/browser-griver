import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")
const userDataDir = mkdtempSync(join(tmpdir(), "griver-chrome-"))

const context = await chromium.launchPersistentContext(userDataDir, {
  // o Chrome de marca ignora --load-extension; o Chromium aceita
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
})

const page = await context.newPage()
await page.goto("chrome://extensions")
await new Promise((r) => setTimeout(r, 1500))

// a página de extensões usa shadow DOM; extrai o texto visível
const info = await page.evaluate(() => {
  const manager = document.querySelector("extensions-manager")
  const list = manager?.shadowRoot?.querySelector("extensions-item-list")
  const items = list?.shadowRoot?.querySelectorAll("extensions-item") ?? []
  return {
    total: items.length,
    details: Array.from(items).map((item) => {
      const shadow = item.shadowRoot
      return {
        name: shadow?.querySelector("#name")?.textContent?.trim(),
        enabled: shadow?.querySelector("#enableToggle")?.getAttribute("aria-pressed"),
        errors: shadow?.querySelector("#errors-button")?.textContent?.trim(),
        description: shadow?.querySelector("#description")?.textContent?.trim(),
      }
    }),
  }
})
console.log(JSON.stringify(info, null, 2))

await context.close()
