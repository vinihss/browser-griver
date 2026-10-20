import type { ProjectSummary, Recipe, RecipeSummary, TargetKind } from "@griver/core"
import { state } from "./state.js"

/**
 * Pede ao service worker o token do servidor atual.
 *
 * O service worker busca o token no servidor a cada consulta e devolve o que
 * vale para ele: o token guardado pode ser de outro servidor, ou de antes de
 * o servidor trocar de token.
 */
async function tokenAtual(): Promise<string> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "panel:status" })) as {
      token?: string
    }
    if (response?.token) {
      state.token = response.token
      return response.token
    }
  } catch {
    // o service worker ainda não respondeu
  }
  return state.token
}

/**
 * Garante que o painel tenha um token antes de chamar a API.
 *
 * O token é lido do servidor pelo service worker. Até ele responder, o
 * painel pode disparar uma chamada — por exemplo quando a extensão avisa
 * que ficou online — e tomar um 401 sem motivo aparente.
 */
async function garantirToken(): Promise<void> {
  if (state.token) return
  await tokenAtual()
}

async function request<T>(path: string, init: RequestInit = {}, novaTentativa = true): Promise<T> {
  await garantirToken()
  const response = await fetch(`${state.serverUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Griver-Token": state.token,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : undefined
  if (!response.ok) {
    // 401: o token em uso não vale para o servidor atual. Renova e tenta de
    // novo uma vez — sem isso o painel abre vazio, sem dizer o motivo
    if (response.status === 401 && novaTentativa) {
      const antigo = state.token
      const novo = await tokenAtual()
      if (novo && novo !== antigo) return await request<T>(path, init, false)
    }
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  return body as T
}

export async function loadProjects(): Promise<ProjectSummary[]> {
  const result = await request<{ projects: ProjectSummary[] }>("/api/projects")
  return result.projects
}

const DEFAULT_PROJECT_NAME = "Meus scripts"

/**
 * Projeto usado quando não há um selecionado.
 *
 * O servidor exige `projectId` ao criar uma receita; como o painel lista
 * todas as receitas sem filtro, basta um projeto padrão — criado uma vez e
 * guardado na extensão.
 */
export async function ensureDefaultProject(): Promise<string> {
  const projects = await loadProjects()

  // o projeto guardado pode ter sido removido — aí vale o primeiro da lista
  const stored = await chrome.storage.local.get("griver.defaultProjectId")
  const saved = stored["griver.defaultProjectId"] as string | undefined
  if (saved && projects.some((project) => project.id === saved)) return saved

  const existing = projects.find((project) => project.name === DEFAULT_PROJECT_NAME)
  const project = existing ?? (await createProject(DEFAULT_PROJECT_NAME))
  await chrome.storage.local.set({ "griver.defaultProjectId": project.id })
  return project.id
}

export async function createProject(name: string, description?: string): Promise<ProjectSummary> {
  const result = await request<{ project: ProjectSummary }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  })
  return result.project
}

export async function deleteProject(id: string): Promise<void> {
  await request(`/api/projects/${id}`, { method: "DELETE" })
}

export async function loadRecipes(projectId?: string): Promise<RecipeSummary[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
  const result = await request<{ recipes: RecipeSummary[] }>(`/api/recipes${query}`)
  return result.recipes
}

export async function loadRecipe(id: string): Promise<{ summary: RecipeSummary; body: Recipe }> {
  return await request(`/api/recipes/${id}`)
}

export async function createRecipe(input: {
  projectId: string
  name: string
  target: TargetKind
  recipe: Recipe
}): Promise<RecipeSummary> {
  const result = await request<{ recipe: RecipeSummary }>("/api/recipes", {
    method: "POST",
    body: JSON.stringify(input),
  })
  return result.recipe
}

export async function updateRecipe(
  id: string,
  patchData: { name?: string; target?: TargetKind; recipe?: Recipe },
): Promise<RecipeSummary> {
  const result = await request<{ recipe: RecipeSummary }>(`/api/recipes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patchData),
  })
  return result.recipe
}

export async function deleteRecipe(id: string): Promise<void> {
  await request(`/api/recipes/${id}`, { method: "DELETE" })
}

export async function validateRecipe(recipe: Recipe, target: TargetKind) {
  const result = await request<{ issues: { path: string; message: string; severity: string }[] }>(
    "/api/validate",
    { method: "POST", body: JSON.stringify({ recipe, target }) },
  )
  return result.issues
}

export async function compileRecipe(id: string, target: TargetKind): Promise<string> {
  const result = await request<{ code: string }>(`/api/recipes/${id}/compile`, {
    method: "POST",
    body: JSON.stringify({ target }),
  })
  return result.code
}

export async function startServerRun(recipeId: string, driver: string) {
  return await request<{ runId: string }>("/api/runs", {
    method: "POST",
    body: JSON.stringify({ recipeId, driver }),
  })
}

export async function listRuns() {
  const result = await request<{ runs: import("@griver/core").RunSummary[] }>("/api/runs")
  return result.runs
}
