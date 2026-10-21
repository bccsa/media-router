# mr-bus-fanout — native GstUnixFd fan-out sidecar for non-GStreamer bus
# producers (hls-player): the TS moved onto house time, stamped by identity.
# Linux-only.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
# Owning plugin folder — the root Makefile passes this when fanning out;
# the default keeps a standalone `make install` here working.
MR_PLUGIN  ?= unixfdbus-core

# The TS primitives and the identity stamp live with the shared TS code
# (mpegts-core library plugin); MR_PLUGINS_DIR points at the plugins root.
MR_PLUGINS_DIR ?= ../../..
MRTS = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/mpegts-core/native

MRTS_HDRS = $(addprefix $(MRTS)/,lateness.h ts_house.h ts_packet.h ts_pes.h ts_pcr.h ts_psi.h)
REBASE = house_rebase.cpp house_rebase.h
TESTS = tests/house_rebase_test

ifeq ($(shell uname -s),Linux)

all: mr-bus-fanout

# Each library decides whether its archive is stale, whatever order the root
# Makefile reaches the directories in; mr-bus-fanout relinks only when one changed.
../libmrbus/libmrbus.a: FORCE
	$(MAKE) -C ../libmrbus

$(MRTS)/libmrts.a: FORCE
	$(MAKE) -C $(MRTS) libmrts.a

FORCE:

mr-bus-fanout: main.cpp $(REBASE) $(MRTS_HDRS) ../libmrbus/libmrbus.a $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) main.cpp house_rebase.cpp ../libmrbus/libmrbus.a $(MRTS)/libmrts.a -o $@

# The rebase alone (no sockets); the protocol runs from vitest (unixfdFanout.test.ts).
tests/house_rebase_test: tests/house_rebase_test.cpp $(REBASE) $(MRTS_HDRS) $(MRTS)/tests/check.h $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $< house_rebase.cpp $(MRTS)/libmrts.a -o $@

test: $(TESTS)
	@for t in $(TESTS); do ./$$t || exit 1; done

clean:
	rm -f mr-bus-fanout $(TESTS)

install: mr-bus-fanout
	install -D -m 755 mr-bus-fanout $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/mr-bus-fanout

else
all test clean install:
	@# Linux-only (memfd_create, SCM_RIGHTS) — skipped on this platform.
endif

.PHONY: all test clean install
