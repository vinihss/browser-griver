/**
 * Ponto de entrada do servidor MCP do Griver.
 *
 * `griver-mcp` é o comando que o OpenCode sobe para ter as ferramentas do
 * Griver à mão. Ele não faz nada além de ouvir o stdin: quem conversa com
 * o Griver é o servidor local, pela REST.
 */
import { escutar } from "./server.js"

escutar()
