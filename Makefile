# Native plugin code — global build entry point. Auto-discovers every
# plugins/<plugin>/native/<tool>/Makefile at invocation time, so adding
# native code to a plugin needs NO registration here (see plugins/README.md,
# "Native & Python code in plugins").
#
#   make native            build every native tool (host arch)
#   make native-test       build + run the C++ test suites
#   make native-install    install binaries to $(DESTDIR)$(PREFIX)/libexec/media-router/<plugin>/
#   make native-clean      remove all native build artifacts
#
# Cross builds: pass CXX (e.g. CXX=aarch64-linux-gnu-g++) — what the Yocto
# recipe does via oe_runmake — or use ./build-native-dev.sh <arch> (Docker,
# no cross toolchain needed). Inter-plugin dependencies (static archives from
# library plugins) are declared as make prerequisites inside each tool's
# Makefile, so build order never matters here.

NATIVE_DIRS := $(patsubst %/Makefile,%,$(wildcard plugins/*/native/*/Makefile))

# Fail with a clear message instead of a cryptic compile error.
preflight:
	@command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || \
	  { echo "error: no C++ compiler found — install g++ (or pass CXX=<cross-g++>)"; exit 1; }

# MR_PLUGIN (= the plugin folder name, 2nd path component) namespaces the
# install: /usr/libexec/media-router/<plugin>/<tool>.
native: preflight
	@set -e; for d in $(NATIVE_DIRS); do \
	  $(MAKE) -C $$d all MR_PLUGIN=$$(echo $$d | cut -d/ -f2); done

native-test: preflight
	@set -e; for d in $(NATIVE_DIRS); do \
	  $(MAKE) -C $$d test MR_PLUGIN=$$(echo $$d | cut -d/ -f2); done

native-install:
	@set -e; for d in $(NATIVE_DIRS); do \
	  $(MAKE) -C $$d install MR_PLUGIN=$$(echo $$d | cut -d/ -f2); done

native-clean:
	@set -e; for d in $(NATIVE_DIRS); do \
	  $(MAKE) -C $$d clean MR_PLUGIN=$$(echo $$d | cut -d/ -f2); done

# Plain `clean` alias: BitBake's stock do_configure runs `oe_runmake clean`
# whenever ${S} has a Makefile — without this alias that step (and a plain
# `make clean`) would fail with "No rule to make target 'clean'".
clean: native-clean

.PHONY: preflight native native-test native-install native-clean clean
