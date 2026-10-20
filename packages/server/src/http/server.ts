import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { URL } from "node:url"

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  query: URLSearchParams
  body: () => Promise<unknown>
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown

interface Route {
  method: string
  segments: string[]
  handler: Handler
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler })
    return this
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler)
  }
  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler)
  }
  patch(pattern: string, handler: Handler): this {
    return this.add("PATCH", pattern, handler)
  }
  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler)
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = pathname.split("/").filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i]!
        const part = parts[i]!
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(part)
        } else if (segment !== part) {
          ok = false
          break
        }
      }
      if (ok) return { handler: route.handler, params }
    }
    return undefined
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, "corpo da requisição não é JSON válido")
  }
}

export function createHttpServer(router: Router, options: { token?: string } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    const origin = req.headers.origin

    // CORS só para a própria extensão: páginas da web não podem ler as respostas
    if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
      res.setHeader("Access-Control-Allow-Origin", origin)
      res.setHeader("Vary", "Origin")
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Griver-Token")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")

    if (req.method === "OPTIONS") {
      res.writeHead(204).end()
      return
    }

    const route = router.match(req.method ?? "GET", url.pathname)
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "rota não encontrada" }))
      return
    }

    // rotas públicas explicitamente liberadas
    const isPublic =
      url.pathname === "/api/health" ||
      url.pathname === "/api/info" ||
      url.pathname === "/api/extension-token"
    if (options.token && !isPublic) {
      const provided = req.headers["x-griver-token"]
      const auth = req.headers.authorization
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
      if (provided !== options.token && bearer !== options.token) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "token inválido" }))
        return
      }
    }

    try {
      const ctx: RequestContext = {
        req,
        res,
        url,
        params: route.params,
        query: url.searchParams,
        body: () => readBody(req),
      }
      const result = await route.handler(ctx)
      if (res.writableEnded) return
      const payload = result === undefined ? { ok: true } : result
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(payload))
    } catch (error) {
      if (res.writableEnded) return
      if (error instanceof HttpError) {
        res.writeHead(error.status, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: error.message, detail: error.detail }))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error("[http] erro:", error)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: message }))
    }
  })

  return server
}
