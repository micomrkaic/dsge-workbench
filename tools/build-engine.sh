#!/bin/sh
# build-engine.sh — compile the Cozy interpreter to WebAssembly for the workbench.
#
#   tools/build-engine.sh /path/to/a/cozy/checkout
#
# Writes docs/vendor/cozy-engine.js: one file (the .wasm is inside it) that
# loads in a browser page, a web worker and node. It holds Cozy's core, its
# embedding API (cozy.h) and the dsge package. Nothing of Cozy is edited
# here; the version built is recorded in docs/vendor/COZY_VERSION.
#
# Needs Emscripten. An emcc whose clang predates C23 keywords gets them as
# macros (detected below).
set -eu
src=${1:?usage: tools/build-engine.sh /path/to/a/cozy/checkout}
cd "$(dirname "$0")/.."
[ -f "$src/embed.c" ] || { echo "build-engine: $src is not a Cozy checkout with the embedding library (0.1.30 or later)" >&2; exit 1; }
EMCC=${EMCC:-emcc}
mkdir -p build docs/vendor
shims=
printf 'void *p = nullptr;\n' > build/c23.c
$EMCC -std=gnu2x -fsyntax-only build/c23.c 2>/dev/null || shims="-Dnullptr=NULL -Dalignof=_Alignof -Dtypeof=__typeof__ -Dstatic_assert=_Static_assert"
srcs=
for f in lexer arena ast parser value eval chunk compile vm sparse linalg_tier0 embed; do srcs="$srcs $src/$f.c"; done
$EMCC -std=gnu2x -O2 $shims \
  -sMODULARIZE=1 -sEXPORT_NAME=CozyEngine -sENVIRONMENT=web,worker,node \
  -sSINGLE_FILE=1 -sALLOW_MEMORY_GROWTH=1 -sSUPPORT_LONGJMP=1 \
  -sEXPORTED_FUNCTIONS=_cozy_open,_cozy_eval,_cozy_ok,_cozy_output,_cozy_matrix,_cozy_scalar,_cozy_string,_cozy_version,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,UTF8ToString,getValue \
  --embed-file "$src/packages/dsge.cz@/packages/dsge.cz" \
  $srcs -o docs/vendor/cozy-engine.js
version=$(sed -n 's/.*COZY_VERSION "\([0-9.]*\)".*/\1/p' "$src/version.h")
commit=$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)
printf 'Cozy %s (commit %s), from https://github.com/micomrkaic/cozy\nBuilt by tools/build-engine.sh; the dsge package is inside.\n' "$version" "$commit" > docs/vendor/COZY_VERSION
echo "build-engine: docs/vendor/cozy-engine.js ($(wc -c < docs/vendor/cozy-engine.js) bytes), Cozy $version ($commit)"
