import { h, button, targetBadge } from "../dom.js"
import { state, patch, setNotice } from "../state.js"
import {
  compileRecipe,
  createRecipe,
  deleteRecipe,
  ensureDefaultProject,
  loadProjects,
  loadRecipe,
  loadRecipes,
  updateRecipe,
  validateRecipe,
} from "../api.js"
import { safeParseRecipe, type Recipe } from "@griver/core"
import { sendToServer } from "../messaging.js"

/** textarea do editor — mantido entre renders para não perder o foco. */
let editorElement: HTMLTextAreaElement | undefined
/** chave da receita que o editor está mostrando */
let editorKey = ""
/**
 * Valores digitados no modal.
 *
 * O painel é redesenhado a cada mensagem do servidor, e o modal é recriado
 * junto — sem guardar os valores, o que a pessoa digitou sumiria.
 */
let addScriptName = ""
let addScriptUrlInput = ""

/** Identifica o que o editor está editando agora. */
function currentEditorKey(): string {
  return state.selectedRecipeId || (state.draftRecipe ? "rascunho" : "")
}

/**
 * Tela de Receitas: lista plana das receitas salvas no servidor.
 *
 * Cada linha traz o título (truncado) e dois botões: editar e executar.
 */
export function recipesView(): HTMLElement {
  const container = h("div", { class: "view" })

  container.appendChild(
    h(
      "div",
      { class: "row", style: "justify-content: space-between" },
      h("div", { class: "section-title" }, "Receitas"),
      button(
        "● Gravar",
        () => {
          void chrome.runtime.sendMessage({ type: "panel:record", action: "start" })
          setNotice("Gravação iniciada. Interaja com a página.")
        },
        { variant: "primary", title: "Grava as ações na aba atual" },
      ),
    ),
  )
  container.appendChild(recipeList())

  // o editor aparece para uma receita salva ou para o rascunho da gravação
  if (state.selectedRecipeId || state.draftRecipe) {
    container.appendChild(editor())
    container.appendChild(actions())
  }

  if (state.showAddScript) {
    container.appendChild(addScriptModal())
  }

  return container
}

/** Lista de receitas do servidor, sem filtro de projeto. */
function recipeList(): HTMLElement {
  const list = h("div", { class: "list" })

  if (!state.recipes.length) {
    list.appendChild(
      h("p", { class: "empty" }, "Nenhuma receita ainda. Use o botão + para criar a primeira."),
    )
    return list
  }

  for (const recipe of state.recipes) {
    const isSelected = recipe.id === state.selectedRecipeId
    const row = h(
      "div",
      { class: `recipe-row${isSelected ? " selected" : ""}` },
      h(
        "button",
        {
          class: "recipe-row-main",
          title: recipe.name,
          onclick: () => void openRecipe(recipe.id),
        },
        h("span", { class: "truncate" }, recipe.name),
        targetBadge(recipe.target),
      ),
      h(
        "div",
        { class: "row-actions" },
        h(
          "button",
          {
            class: "icon-btn",
            title: "Editar",
            "aria-label": `Editar ${recipe.name}`,
            onclick: () => void openRecipe(recipe.id),
          },
          "✎",
        ),
        h(
          "button",
          {
            class: "icon-btn",
            title: "Executar",
            "aria-label": `Executar ${recipe.name}`,
            onclick: () => void runRecipe(recipe.id),
          },
          "▶",
        ),
      ),
    )
    list.appendChild(row)
  }

  return list
}

/** Carrega a receita no editor. */
async function openRecipe(id: string): Promise<void> {
  try {
    const found = await loadRecipe(id)
    patch({
      selectedRecipeId: id,
      draftRecipe: undefined,
      recipeText: JSON.stringify(found.body, null, 2),
      recipeTarget: found.summary.target,
      recipeDirty: false,
      recipeIssues: [],
    })
  } catch (error) {
    setNotice(describeError(error), "error")
  }
}

/** Executa a receita na aba atual. */
async function runRecipe(id: string): Promise<void> {
  try {
    const found = await loadRecipe(id)
    await updateRecipe(id, { recipe: found.body })
    sendToServer({ type: "run.start", recipeId: id, driver: "tab" })
    setNotice(`Executando "${found.summary.name}"…`)
  } catch (error) {
    setNotice(describeError(error), "error")
  }
}

/**
 * Modal "Add New Script".
 *
 * O URL vira o `startUrl` da receita — o campo existe no schema mas nunca era
 * preenchido pelo formulário antigo.
 */
function addScriptModal(): HTMLElement {
  const nameInput = h("input", {
    class: "input",
    placeholder: "Nome do script",
    value: addScriptName,
    oninput: (event: Event) => {
      addScriptName = (event.target as HTMLInputElement).value
    },
  }) as HTMLInputElement

  const urlInput = h("input", {
    class: "input",
    placeholder: "https://exemplo.com",
    value: state.addScriptUrl || addScriptUrlInput,
    oninput: (event: Event) => {
      addScriptUrlInput = (event.target as HTMLInputElement).value
    },
  }) as HTMLInputElement

  // a URL vinda da gravação é a fonte da verdade quando o modal abre
  if (state.addScriptUrl && state.addScriptUrl !== addScriptUrlInput) {
    addScriptUrlInput = state.addScriptUrl
    urlInput.value = state.addScriptUrl
  }

  const close = () => {
    addScriptName = ""
    addScriptUrlInput = ""
    patch({ showAddScript: false, addScriptUrl: "" })
  }
  const save = async () => {
    const name = nameInput.value.trim()
    if (!name) {
      setNotice("Dê um nome ao script.", "error")
      return
    }
    const url = urlInput.value.trim()
    // o rascunho da gravação traz os passos capturados; sem rascunho, a
    // receita começa vazia
    const base = state.draftRecipe ?? { version: 1 as const, steps: [] }
    const recipe: Recipe = {
      ...base,
      ...(url ? { startUrl: url } : {}),
    }
    try {
      // o projeto ativo pode ter sido removido no servidor: a lista real é
      // a fonte da verdade
      const projetos = await loadProjects()
      const existe = projetos.some((p) => p.id === state.selectedProjectId)
      const projectId = existe
        ? state.selectedProjectId
        : await ensureDefaultProject()
      const created = await createRecipe({
        projectId,
        name,
        target: state.recipeTarget,
        recipe,
      })
      const recipes = await loadRecipes()
      addScriptName = ""
      addScriptUrlInput = ""
      patch({
        recipes,
        selectedRecipeId: created.id,
        draftRecipe: undefined,
        recipeText: JSON.stringify(recipe, null, 2),
        recipeDirty: false,
        recipeIssues: [],
        showAddScript: false,
        addScriptUrl: "",
      })
      setNotice(`Receita "${name}" criada.`)
    } catch (error) {
      setNotice(describeError(error), "error")
    }
  }

  const backdrop = h(
    "div",
    {
      class: "modal-backdrop",
      onclick: (event: Event) => {
        if (event.target === backdrop) close()
      },
    },
    h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-title" }, "Add New Script"),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), nameInput),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "URL"), urlInput),
      h(
        "div",
        { class: "modal-actions" },
        button("Save", () => void save(), { variant: "primary" }),
        button("Cancel", close, { variant: "ghost" }),
      ),
    ),
  )

  return backdrop
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

  // o texto só é reescrito quando a receita sendo editada muda — do contrário
  // o cursor do usuário volta ao começo a cada tecla
  if (editorKey !== currentEditorKey()) {
    editorKey = currentEditorKey()
    editorElement.value = state.recipeText
  }

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
  const rascunho = state.draftRecipe !== undefined && !state.selectedRecipeId

  row.appendChild(
    button(
      "Salvar",
      async () => {
        const parsed = safeParseRecipe(parseJson(state.recipeText))
        if (!parsed.success) {
          setNotice("O JSON da receita está inválido.", "error")
          return
        }
        // o rascunho da gravação ainda não tem onde ser salvo: o modal pede
        // o nome e a URL, e cria a receita a partir do que foi gravado
        if (rascunho) {
          patch({
            draftRecipe: parsed.data,
            showAddScript: true,
            addScriptUrl: parsed.data.startUrl ?? state.addScriptUrl,
          })
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
        // um rascunho ainda não está no servidor: só faz sentido executar
        // depois de salvo
        if (rascunho) {
          setNotice("Salve a receita antes de executar.", "error")
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
      "Exportar",
      async () => {
        if (rascunho) {
          setNotice("Salve a receita antes de exportar.", "error")
          return
        }
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
        // no rascunho, "remover" só descarta o rascunho
        if (rascunho) {
          patch({ draftRecipe: undefined, recipeText: "", recipeDirty: false })
          setNotice("Rascunho descartado.")
          return
        }
        try {
          await deleteRecipe(state.selectedRecipeId)
          patch({ selectedRecipeId: "", recipeText: "", recipeDirty: false })
          const recipes = await loadRecipes()
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
