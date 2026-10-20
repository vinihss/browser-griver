import { h, button, targetBadge } from "../dom.js"
import { state, patch, setNotice } from "../state.js"
import {
  compileRecipe,
  createRecipe,
  deleteRecipe,
  loadRecipe,
  loadRecipes,
  updateRecipe,
  validateRecipe,
} from "../api.js"
import { safeParseRecipe, type Recipe } from "@griver/core"
import { recordCommand, sendToServer } from "../messaging.js"

/** textarea do editor — mantido entre renders para não perder o foco. */
let editorElement: HTMLTextAreaElement | undefined
let editorRecipeId = ""

export function recipesView(): HTMLElement {
  const container = h("div", { class: "view" })

  // Linha de botões no topo: Voltar e Nova receita
  const topBar = h("div", { class: "row wrap" })
  topBar.appendChild(
    button(
      "Voltar para projetos",
      async () => {
        patch({ selectedProjectId: "", selectedRecipeId: "", tab: "projetos" })
      },
      { variant: "ghost" },
    ),
  )
  topBar.appendChild(
    button(
      "Nova receita",
      () => void createEmptyRecipe(),
      { variant: "primary" },
    ),
  )

  container.appendChild(topBar)
  container.appendChild(recipeList())

  if (!state.selectedRecipeId) {
    container.appendChild(
      h("p", { class: "empty" }, "Selecione uma receita para editar, ou grave uma nova."),
    )
    return container
  }

  container.appendChild(editor())
  container.appendChild(actions())
  return container
}

/** Cria uma receita vazia para escrever à mão. */
async function createEmptyRecipe(): Promise<void> {
  if (!state.selectedProjectId) {
    setNotice("Escolha um projeto antes de criar a receita.", "error")
    return
  }

  const nome = window.prompt("Nome da nova receita:", "Nova receita")?.trim()
  if (!nome) return

  try {
    const recipe: Recipe = { version: 1, steps: [] }
    const created = await createRecipe({
      projectId: state.selectedProjectId,
      name: nome,
      target: state.recipeTarget,
      recipe,
    })
    const recipes = await loadRecipes(state.selectedProjectId)
    editorRecipeId = created.id
    patch({
      recipes,
      selectedRecipeId: created.id,
      recipeText: JSON.stringify(recipe, null, 2),
      recipeDirty: false,
      recipeIssues: [],
    })
    setNotice(`Receita "${nome}" criada.`)
  } catch (error) {
    setNotice(describeError(error), "error")
  }
}

function recipeList(): HTMLElement {
  const list = h("div", { class: "list" })

  if (!state.recipes.length) {
    list.appendChild(h("p", { class: "empty" }, "Nenhuma receita neste projeto."))
    return list
  }

  for (const recipe of state.recipes) {
    const isSelected = recipe.id === state.selectedRecipeId
    list.appendChild(
      h(
        "div",
        { class: `list-item${isSelected ? " selected" : ""}` },
        h(
          "button",
          {
            class: "list-item-main",
            onclick: async () => {
              try {
                const found = await loadRecipe(recipe.id)
                editorRecipeId = recipe.id
                patch({
                  selectedRecipeId: recipe.id,
                  recipeText: JSON.stringify(found.body, null, 2),
                  recipeTarget: found.summary.target,
                  recipeDirty: false,
                  recipeIssues: [],
                })
              } catch (error) {
                setNotice(error instanceof Error ? error.message : String(error), "error")
              }
            },
          },
          h("span", { class: "list-item-title" }, recipe.name),
          h("span", { class: "list-item-meta" }, `${recipe.stepCount ?? 0} passos`),
          targetBadge(recipe.target),
        ),
      ),
    )
  }

  return list
}

function editor(): HTMLElement {
  const wrapper = h("div", { class: "editor" })

  if (!editorElement) {
    editorElement = h("textarea", {
      class: "textarea code",
      spellcheck: "false",
      rows: 14,
      oninput: (event: Event) => {
        state.recipeText = (event.target as HTMLTextAreaElement).value
        patch({ recipeDirty: true })
      },
    })
  }
  if (editorElement.value !== state.recipeText && editorRecipeId !== state.selectedRecipeId) {
    editorElement.value = state.recipeText
  } else if (editorElement.value !== state.recipeText && state.recipeDirty === false) {
    editorElement.value = state.recipeText
  }
  editorRecipeId = state.selectedRecipeId

  wrapper.appendChild(
    h(
      "div",
      { class: "editor-head" },
      h("span", { class: "editor-title" }, "Script da receita"),
      state.recipeDirty ? h("span", { class: "badge badge-dirty" }, "alterado") : null,
    ),
  )
  wrapper.appendChild(editorElement)

  if (state.recipeIssues.length) {
    const issues = h("div", { class: "issues" })
    for (const issue of state.recipeIssues) {
      issues.appendChild(
        h(
          "div",
          { class: `issue issue-${issue.severity}` },
          h("code", {}, issue.path),
          " ",
          issue.message,
        ),
      )
    }
    wrapper.appendChild(issues)
  }

  return wrapper
}

function actions(): HTMLElement {
  const row = h("div", { class: "row wrap" })

  row.appendChild(
    button(
      "Salvar",
      async () => {
        const parsed = safeParseRecipe(parseJson(state.recipeText))
        if (!parsed.success) {
          setNotice("O JSON da receita está inválido.", "error")
          return
        }
        try {
          await updateRecipe(state.selectedRecipeId, {
            recipe: parsed.data,
            target: state.recipeTarget,
          })
          patch({ recipeDirty: false, recipeIssues: [] })
          setNotice("Receita salva.")
        } catch (error) {
          setNotice(describeError(error), "error")
        }
      },
      { variant: "primary" },
    ),
  )

  row.appendChild(
    button(
      "Validar",
      async () => {
        const parsed = safeParseRecipe(parseJson(state.recipeText))
        if (!parsed.success) {
          setNotice("O JSON da receita está inválido.", "error")
          return
        }
        try {
          const issues = await validateRecipe(parsed.data, state.recipeTarget)
          patch({ recipeIssues: issues })
          setNotice(
            issues.length ? `${issues.length} aviso(s) para o alvo ${state.recipeTarget}.` : "Receita válida.",
            issues.length ? "error" : "info",
          )
        } catch (error) {
          setNotice(describeError(error), "error")
        }
      },
    ),
  )

  row.appendChild(
    button(
      "Executar aqui",
      async () => {
        const parsed = safeParseRecipe(parseJson(state.recipeText))
        if (!parsed.success) {
          setNotice("O JSON da receita está inválido.", "error")
          return
        }
        try {
          await updateRecipe(state.selectedRecipeId, { recipe: parsed.data })
        } catch (error) {
          setNotice(describeError(error), "error")
          return
        }
        sendToServer({ type: "run.start", recipeId: state.selectedRecipeId, driver: "tab" })
        setNotice("Executando na aba atual…")
      },
      { variant: "primary", title: "Roda a receita na aba ativa" },
    ),
  )

  row.appendChild(
    button(
      "Executar headless",
      async () => {
        const parsed = safeParseRecipe(parseJson(state.recipeText))
        if (!parsed.success) {
          setNotice("O JSON da receita está inválido.", "error")
          return
        }
        try {
          await updateRecipe(state.selectedRecipeId, { recipe: parsed.data })
          sendToServer({
            type: "run.start",
            recipeId: state.selectedRecipeId,
            driver: state.recipeTarget === "os" ? "firecrawl" : "playwright",
          })
          setNotice("Executando no servidor…")
        } catch (error) {
          setNotice(describeError(error), "error")
        }
      },
      { title: "Roda a receita no servidor, sem abrir o navegador" },
    ),
  )

  row.appendChild(
    button(
      "Exportar",
      async () => {
        try {
          const code = await compileRecipe(state.selectedRecipeId, state.recipeTarget)
          await navigator.clipboard.writeText(code)
          setNotice("Código copiado para a área de transferência.")
        } catch (error) {
          setNotice(describeError(error), "error")
        }
      },
    ),
  )

  row.appendChild(
    button(
      "Remover",
      async () => {
        try {
          await deleteRecipe(state.selectedRecipeId)
          patch({ selectedRecipeId: "", recipeText: "", recipeDirty: false })
          const recipes = await loadRecipes(state.selectedProjectId || undefined)
          patch({ recipes })
          setNotice("Receita removida.")
        } catch (error) {
          setNotice(describeError(error), "error")
        }
      },
      { variant: "danger" },
    ),
  )

  return row
}

/** Cria uma receita nova a partir da gravação atual. */
export async function createRecipeFromRecording(name: string): Promise<void> {
  if (!state.selectedProjectId) {
    setNotice("Escolha um projeto antes de salvar a receita.", "error")
    return
  }

  try {
    // usa a receita gerada pela gravação; se não houver, parte de uma vazia
    const recipe: Recipe = state.recordedRecipe ?? { version: 1, steps: [] }
    const created = await createRecipe({
      projectId: state.selectedProjectId,
      name,
      target: state.recipeTarget,
      recipe,
    })
    const recipes = await loadRecipes(state.selectedProjectId || undefined)
    patch({
      recipes,
      selectedRecipeId: created.id,
      recipeText: JSON.stringify(recipe, null, 2),
      recipeDirty: false,
      recordedRecipe: undefined,
    })
  } catch (error) {
    setNotice(describeError(error), "error")
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export { recordCommand }
