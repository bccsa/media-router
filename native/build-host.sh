#!/bin/sh
# Build the portable parts (mrts core + tests + mrts_cli) with the host
# toolchain — works on any Linux or macOS with a C++17 compiler. Used by the
# vitest golden-parity suite; safe to run standalone.
#   ./build-host.sh          build
#   ./build-host.sh test     build + run C++ unit tests
set -e
cd "$(dirname "$0")"
# A cross-build (build-dev.sh) leaves foreign-arch objects behind with fresh
# timestamps; probe the harness binary and start clean when it can't run here
# (no args -> usage, exit 2; a foreign ELF fails to exec entirely).
if [ -x mrts/mrts_cli ]; then
    rc=0
    ./mrts/mrts_cli >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq 2 ] || make -C mrts clean >/dev/null
fi
exec make -C mrts "${1:-all}"
