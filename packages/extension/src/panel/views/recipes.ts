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
  urlCorrente,
  validateRecipe,
} from "../api.js"
import { safeParseRecipe, type Recipe } from "@griver/core"
import { sendToServer } from "../messaging.js"

/** textarea do editor — mantido entre renders para não perder o foco. */
let editorElement: HTMLTextAreaElement | undefined
/** campo do nome — mantido entre renders pelo mesmo motivo. */
let nameElement: HTMLInputElement | undefined
/** chave da receita que a tela está editando */
let editorKey = ""

/** Identifica o que a tela está editando agora. */
function currentEditorKey(): string {
  const alvo = state.selectedRecipeId || (state.draftRecipe ? "rascunho" : "")
  return `${alvo}#${state.recipeEpoch}`
}

/** Receita vazia, no formato em que ela é salva. */
function receitaVazia(): string {
  return JSON.stringify({ version: 1 as const, steps: [] }, null, 2)
}

function ensureEditor(): HTMLTextAreaElement {
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
  return editorElement
}

function ensureNameField(): HTMLInputElement {
  if (!nameElement) {
    nameElement = h("input", {
      class: "input",
      placeholder: "Nome do script",
      oninput: (event: Event) => {
        // grava direto no estado, sem `patch`: cada tecla redesenharia a
        // tela e o cursor voltaria ao começo do campo
        state.recipeName = (event.target as HTMLInputElement).value
      },
    })
  }
  return nameElement
}

/**
 * Tela de Receitas — duas telas, uma por vez.
 *
 * A lista é a tela principal: só as receitas do servidor. O editor não fica
 * embutido nela; ele é uma tela dedicada, aberta pelo `+` do cabeçalho ou
 * pelo `✎`/clique de cada linha — e é ali que ficam Nome, o JSON, as
 * ações e o botão **● Gravar**.
 */
export function recipesView(): HTMLElement {
  return state.editorOpen ? editorScreen() : listScreen()
}

/** Lista plana das receitas salvas no servidor. */
function listScreen(): HTMLElement {
  const container = h("div", { class: "view" })
  container.appendChild(h("div", { class: "section-title" }, "Receitas"))
  container.appendChild(recipeList())
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

/**
 * Abre a tela de edição para uma receita nova.
 *
 * Não existe modal: a tela já nasce com o campo Nome, o editor e os botões.
 * Salvar cria a receita (a URL é a da página em que o usuário está) e a
 * tela segue aberta, agora sobre a receita criada.
 */
export function openNewRecipe(): void {
  // uma gravação esperando para ser salva não se perde num clique no "+"
  if (state.draftRecipe) {
    patch({ tab: "receitas", editorOpen: true })
    return
  }
  patch({
    tab: "receitas",
    editorOpen: true,
    selectedRecipeId: "",
    recipeName: "",
    recipeText: receitaVazia(),
    recipeEpoch: state.recipeEpoch + 1,
    recipeDirty: false,
    recipeIssues: [],
  })
}

/** Volta para a lista. */
function closeEditor(): void {
  patch({ editorOpen: false })
  // a lista volta sempre fresca: a receita pode ter mudado enquanto a tela
  // de edição estava aberta
  loadRecipes()
    .then((recipes) => patch({ recipes }))
    .catch(() => undefined)
}

/** Carrega a receita e abre a tela de edição com ela. */
async function openRecipe(id: string): Promise<void> {
  try {
    const found = await loadRecipe(id)
    patch({
      editorOpen: true,
      selectedRecipeId: id,
      draftRecipe: undefined,
      recipeName: found.summary.name,
      recipeText: JSON.stringify(found.body, null, 2),
      recipeEpoch: state.recipeEpoch + 1,
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
    sendToServer({ type: "run.start", recipeId: id, driver: "tab" })
    setNotice(`Executando "${found.summary.name}"…`)
  } catch (error) {
    setNotice(describeError(error), "error")
  }
}

// ── tela de edição ──────────────────────────────────────────────────────────

function editorScreen(): HTMLElement {
  const container = h("div", { class: "view" })
  const novo = state.selectedRecipeId === ""

  const editor = ensureEditor()
  const nameInput = ensureNameField()

  // os campos só reescrevem o valor quando a receita sendo editada muda —
  // do contrário o cursor do usuário volta ao começo a cada tecla
  if (editorKey !== currentEditorKey()) {
    editorKey = currentEditorKey()
    editor.value = state.recipeText
    nameInput.value = state.recipeName
  }

  container.appendChild(screenHeader(novo))
  container.appendChild(
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Nome"), nameInput),
  )
  container.appendChild(editorBox(editor))
  container.appendChild(actions())
  return container
}

/**
 * Cabeçalho da tela de edição: voltar para a lista + gravação.
 *
 * O **● Gravar** mora aqui, e não mais na lista: gravar é uma ação sobre a
 * receita que está aberta. Enquanto a captura corre, o mesmo espaço vira o
 * contador de passos e o botão de parar — a página não tem mais nenhuma
 * lista de passos presa nela.
 */
function screenHeader(novo: boolean): HTMLElement {
  const gravacao = state.recording.active
    ? h(
        "div",
        { class: "row" },
        h(
          "span",
          { class: "badge badge-rec" },
          `${state.recording.paused ? "pausado" : "gravando"} · ${state.recording.steps} passos`,
        ),
        button("⏹ Parar", stopGravacao, { title: "Encerra a gravação" }),
      )
    : button("● Gravar", startGravacao, {
        variant: "primary",
        title: "Grava as ações na aba atual",
      })

  return h(
    "div",
    { class: "row editor-top" },
    h(
      "div",
      { class: "row editor-top-left" },
      h(
        "button",
        {
          class: "icon-btn",
          title: "Voltar para a lista",
          "aria-label": "Voltar para a lista",
          onclick: closeEditor,
        },
        "←",
      ),
      h(
        "span",
        { class: "editor-heading" },
        novo ? "Nova receita" : state.recipeName.trim() || "Receita",
      ),
    ),
    gravacao,
  )
}

function startGravacao(): void {
  void chrome.runtime.sendMessage({ type: "panel:record", action: "start" })
  setNotice("Gravação iniciada. Interaja com a página.")
}

function stopGravacao(): void {
  void chrome.runtime.sendMessage({ type: "panel:record", action: "stop" })
}

function editorBox(editor: HTMLTextAreaElement): HTMLElement {
  const wrapper = h("div", { class: "editor" })

  wrapper.appendChild(
    h(
      "div",
      { class: "editor-head" },
      h("span", { class: "editor-title" }, "Script da receita"),
      state.recipeDirty ? h("span", { class: "badge badge-dirty" }, "alterado") : null,
    ),
  )
  wrapper.appendChild(editor)

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

// ── ações da tela de edição ─────────────────────────────────────────────────

/**
 * Salva a receita da tela de edição.
 *
 * Sem id, cria (nome + URL da página); com id, atualiza a que já existe.
 * O nome vem do campo da própria tela — era o único campo do antigo modal.
 */
async function saveRecipe(): Promise<void> {
  const parsed = safeParseRecipe(parseJson(state.recipeText))
  if (!parsed.success) {
    setNotice("O JSON da receita está inválido.", "error")
    return
  }
  const nome = state.recipeName.trim()
  if (!nome) {
    setNotice("Dê um nome ao script.", "error")
    return
  }

  if (state.selectedRecipeId) {
    try {
      await updateRecipe(state.selectedRecipeId, {
        name: nome,
        recipe: parsed.data,
        target: state.recipeTarget,
      })
      patch({ recipeDirty: false, recipeIssues: [] })
      setNotice("Receita salva.")
    } catch (error) {
      setNotice(describeError(error), "error")
    }
    return
  }

  try {
    // a URL da página em que o usuário está vira o `startUrl` — a receita
    // começa de onde ele está, e não de um endereço digitado à mão. Um
    // `startUrl` já escrito no JSON (o da gravação) tem prioridade.
    const url = parsed.data.startUrl ?? state.draftRecipe?.startUrl ?? (await urlCorrente())
    const recipe: Recipe = { ...parsed.data, ...(url ? { startUrl: url } : {}) }

    // o projeto ativo pode ter sido removido no servidor: a lista real é
    // a fonte da verdade
    const projetos = await loadProjects()
    const existe = projetos.some((p) => p.id === state.selectedProjectId)
    const projectId = existe ? state.selectedProjectId : await ensureDefaultProject()
    const created = await createRecipe({
      projectId,
      name: nome,
      target: state.recipeTarget,
      recipe,
    })
    const recipes = await loadRecipes()
    patch({
      recipes,
      selectedRecipeId: created.id,
      draftRecipe: undefined,
      recipeName: nome,
      recipeText: JSON.stringify(recipe, null, 2),
      recipeEpoch: state.recipeEpoch + 1,
      recipeDirty: false,
      recipeIssues: [],
    })
    setNotice(`Receita "${nome}" criada.`)
  } catch (error) {
    setNotice(describeError(error), "error")
  }
}

function actions(): HTMLElement {
  const row = h("div", { class: "row wrap" })
  // um rascunho que ainda não está no servidor: ele precisa de nome para
  // ser criado
  const rascunho = state.draftRecipe !== undefined && !state.selectedRecipeId
  // uma gravação esperando para ser salva em cima de uma receita que já
  // existe: "Remover" descarta a gravação, não apaga a receita
  const gravado = state.draftRecipe !== undefined && Boolean(state.selectedRecipeId)
  // sem id não existe o que executar nem o que exportar: a receita ainda
  // não foi salva
  const semId = state.selectedRecipeId === ""

  row.appendChild(button("Salvar", () => void saveRecipe(), { variant: "primary" }))

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
        if (semId) {
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
        if (semId) {
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

  // uma receita nova não salva não tem nada a remover — o botão some
  if (!semId || state.draftRecipe) {
    row.appendChild(
      button(
        "Remover",
        async () => {
          // uma gravação ainda não salva: "Remover" descarta a gravação e
          // devolve o texto que está no servidor — apagar a receita seria
          // perder o que ela já tinha
          if (rascunho || gravado) {
            try {
              const texto =
                state.selectedRecipeId === ""
                  ? receitaVazia()
                  : JSON.stringify((await loadRecipe(state.selectedRecipeId)).body, null, 2)
              patch({
                draftRecipe: undefined,
                recipeText: texto,
                recipeEpoch: state.recipeEpoch + 1,
                recipeDirty: false,
              })
              setNotice(rascunho ? "Rascunho descartado." : "Gravação descartada.")
            } catch (error) {
              setNotice(describeError(error), "error")
            }
            return
          }
          try {
            await deleteRecipe(state.selectedRecipeId)
            patch({
              selectedRecipeId: "",
              recipeName: "",
              recipeText: "",
              recipeDirty: false,
              editorOpen: false,
            })
            patch({ recipes: await loadRecipes() })
            setNotice("Receita removida.")
          } catch (error) {
            setNotice(describeError(error), "error")
          }
        },
        { variant: "danger" },
      ),
    )
  }

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
