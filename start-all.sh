#!/usr/bin/env bash
#
# Atalho de sempre: instala, compila e sobe o Griver.
#
# Tudo o que este script fazia — build por pacote, typecheck da extensão,
# zip e servidor no ar — vive agora em `scripts/tasks.mjs`, o ponto único
# das tarefas. O script continua existindo porque é o comando que as
# pessoas já conhecem, e um alias não serve para todo mundo.
set -euo pipefail

cd "$(dirname "$0")"

node scripts/tasks.mjs bootstrap
exec node scripts/tasks.mjs serve
