#!/usr/bin/env bash
set -e

echo "========================================="
echo "📦 Build completo do Griver"
echo "========================================="
cd /home/vinicius/browser-griver

# Step 1: Build core package
echo ""
echo "1️⃣ Building @griver/core..."
pnpm --filter @griver/core run build

# Step 1b: Typecheck da extensão (pega função indefinida antes do build)
echo ""
echo "1b️⃣ Typechecking @griver/extension..."
pnpm --filter @griver/extension exec tsc --noEmit -p tsconfig.json

# Step 2: Build extension
echo ""
echo "2️⃣ Building @griver/extension..."
pnpm --filter @griver/extension run build

# Step 3: Build server
echo ""
echo "3️⃣ Building @griver/server..."
pnpm --filter @griver/server run build

# Step 4: Create ZIP
echo ""
echo "4️⃣ Creating extension ZIP..."
rm -f griver-extension.zip
zip -j griver-extension.zip \
  packages/extension/manifest.json \
  packages/extension/dist/background.js \
  packages/extension/dist/content.js \
  packages/extension/dist/panel.html \
  packages/extension/dist/panel.js \
  packages/extension/dist/styles.css

echo ""
echo "========================================="
echo "✅ Build completo!"
echo "========================================="
echo "• Core: packages/core/dist/"
echo "• Extension: packages/extension/dist/"
echo "• Server: packages/server/dist/"
echo "• ZIP: griver-extension.zip"
echo ""

echo "========================================="
echo "🚀 Iniciando servidor Griver"
echo "========================================="
# Mata qualquer servidor antigo na porta 7331
fuser -k 7331/tcp 2>/dev/null || true
sleep 1

# Inicia o servidor a partir da raiz do projeto.
#
# A pasta de dados é resolvida a partir do diretório atual: rodar dentro de
# packages/server cria o banco e o token em packages/server/data, e o CLI e
# o plugin do OpenCode procuram em <projeto>/data. Com os dois em pastas
# diferentes, o servidor sobe com um token e a extensão recebe 401.
#
# A resolução dos módulos do workspace não depende do diretório: o tsx
# procura o @griver/core a partir do arquivo, não de onde ele foi chamado.
cd /home/vinicius/browser-griver
pnpm exec tsx packages/server/src/main.ts &
SERVER_PID=$!

# Aguarda o servidor estar pronto
sleep 3

echo ""
echo "========================================="
echo "✅ Servidor rodando!"
echo "========================================="
echo "• URL: http://127.0.0.1:7331"
echo "• Token será gerado automaticamente"
echo ""

echo "========================================="
echo "🔧 Desenvolvimento: Atualizações de Código"
echo "========================================="
echo "⚠️  Se você modificar arquivos TypeScript (.ts),"
echo "   será necessário reexecutar o build para ver"
echo "   as mudanças refletidas na extensão."
echo ""
echo "   Para rebuilder rapidamente:"
echo "   1. Pressione Ctrl+C para parar este script"
echo "   2. Execute: bash start-all.sh"
echo ""
echo "   Ou para desenvolvimento rápido, use:"
echo "   - pnpm --filter @griver/extension run build (extensão)"
echo "   - pnpm --filter @griver/server run build (servidor)"
echo ""
echo "   Typecheck (pega função indefinida antes do build):"
echo "   - pnpm --filter @griver/extension exec tsc --noEmit -p tsconfig.json"
echo ""
echo "   Testes end-to-end (rodam em um Chrome real):"
echo "   - pnpm run test:e2e:verifica  (painel)"
echo "   - pnpm run test:e2e:overlay   (barra de gravação na página)"
echo "   - pnpm run test:e2e:nova      (criar receita na tela de edição)"
echo ""

echo "========================================="
echo "🔧 Como configurar a extensão"
echo "========================================="
echo "1. Abra o Chrome e vá em chrome://extensions/"
echo "2. Ative 'Modo de desenvolvedor' (toggle no canto superior direito)"
echo "3. Clique em 'Carregar extensão não compactada'"
echo "4. Selecione: packages/extension/dist/"
echo ""
echo "💡 Dica: Se já tiver a extensão instalada anteriormete,"
echo "   clique no botão 'Reload' (seta circular) ao lado da extensão"
echo "   para carregar as novas alterações sem remover a extensão."
echo ""
echo "💡 A extensão conectará automaticamente ao servidor"
echo "   e as receitas gravadas serão carregadas ao abrir o painel!"
echo ""

echo "========================================="
echo "📦 Extensão pronta: griver-extension.zip"
echo "========================================="
echo "• Local: /home/vinicius/browser-griver/griver-extension.zip"
echo ""

# Aguarda interrupção - usa trap para limpeza
trap 'echo "Parando servidor..."; kill $SERVER_PID 2>/dev/null; exit' INT TERM

# Mantém o script rodando
while true; do
  sleep 60
done