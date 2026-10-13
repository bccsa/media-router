# mr-clockstate — the engine's clock sidecar: E = TAI - MONOTONIC, the kernel's
# adjtimex sync state and timerfd step detection as JSON lines (house-clock
# design §10.3). Linux-only (CLOCK_TAI, adjtimex, timerfd); no library deps.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
# The root Makefile passes the owning folder; for packages/engine it is
# `engine`, so the binary installs to /usr/libexec/media-router/engine/.
MR_PLUGIN  ?= engine

# Only the shared zero-dependency test harness comes from mpegts-core.
MR_PLUGINS_DIR ?= ../../../../plugins
CHECK_H = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts/tests/check.h

BIN   = mr-clockstate
TESTS = tests/clock_sample_test

ifeq ($(shell uname -s),Linux)

all: $(BIN)

$(BIN): main.cpp clock_sample.cpp clock_sample.h
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) main.cpp clock_sample.cpp -o $@

tests/clock_sample_test: tests/clock_sample_test.cpp clock_sample.cpp clock_sample.h $(CHECK_H)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -I$(MR_PLUGINS_DIR)/mpegts-core/native $< clock_sample.cpp -o $@

test: $(TESTS)
	@for t in $(TESTS); do ./$$t || exit 1; done

clean:
	rm -f $(BIN) $(TESTS)

install: $(BIN)
	install -D -m 755 $(BIN) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(BIN)

else
all test clean install:
	@# Linux-only (CLOCK_TAI, adjtimex, timerfd) — skipped on this platform.
endif

.PHONY: all test clean install
