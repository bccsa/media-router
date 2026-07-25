#!/bin/sh
# Build the portable parts (mrts core + tests + mrts_cli) with the host
# toolchain — works on any Linux or macOS with a C++17 compiler. Used by the
# vitest golden-parity suite; safe to run standalone.
#   ./build-host.sh          build
#   ./build-host.sh test     build + run C++ unit tests
set -e
cd "$(dirname "$0")"
exec make -C mrts "${1:-all}"
