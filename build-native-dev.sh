#!/bin/sh
# Dev convenience: build static native plugin binaries via Docker for a chosen
# architecture — no cross toolchain needed. Production builds use the plain
# Makefiles with the platform's own toolchain (`make native`); this script is
# never required by pnpm build or make.
#   ./build-native-dev.sh                 build for the HOST arch
#   ./build-native-dev.sh arm64           build for arm64 (e.g. Intel box -> Pi)
#   ./build-native-dev.sh amd64           build for x86_64
#   ./build-native-dev.sh arm64 test      build + run the C++ test suites
set -e
cd "$(dirname "$0")"

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
    arm64|aarch64) PLATFORM=linux/arm64 ;;
    amd64|x86_64)  PLATFORM=linux/amd64 ;;
    *) echo "error: unsupported arch '$ARCH' (use arm64 or amd64)"; exit 1 ;;
esac

case "${2:-build}" in
    build) TARGET=native ;;
    test)  TARGET=native-test ;;
    *) echo "error: unknown target '$2' (use test or omit)"; exit 1 ;;
esac

exec docker run --rm --platform "$PLATFORM" -v "$PWD":/w gcc:14 \
    make -C /w native-clean "$TARGET" CXXFLAGS="-O2 -static -std=c++17 -Wall -Wextra"
