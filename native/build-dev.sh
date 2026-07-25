#!/bin/sh
# Dev convenience: build static linux/arm64 binaries via Docker (for pushing
# to a test device or running the Linux-only conformance legs from a non-Linux
# host). Production builds use the plain Makefiles with the platform's own
# toolchain — this script is never required by pnpm build or make.
#   ./build-dev.sh          cross-build everything (static, arm64)
#   ./build-dev.sh test     cross-build + run the C++ test suites in the
#                           arm64 container
set -e
cd "$(dirname "$0")"
TARGET="${1:-all}"
exec docker run --rm --platform linux/arm64 -v "$PWD":/w gcc:14 \
    make -C /w clean "$TARGET" CXXFLAGS="-O2 -static -std=c++17 -Wall -Wextra"
