# mr-bus-fanout — native GstUnixFd fan-out sidecar (drop-in replacement for
# unixfd-fanout.py). Linux-only.
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

# The egress timeline stamper lives with the shared TS code (mpegts-core
# library plugin); MR_PLUGINS_DIR points at the plugins root.
MR_PLUGINS_DIR ?= ../../..
MRTS = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/mpegts-core/native

MRTS_HDRS = $(addprefix $(MRTS)/,lateness.h ts_timeline.h ts_house.h)

ifeq ($(shell uname -s),Linux)

all: mr-bus-fanout

# Each library decides whether its archive is stale, whatever order the root
# Makefile reaches the directories in; mr-bus-fanout relinks only when one changed.
../libmrbus/libmrbus.a: FORCE
	$(MAKE) -C ../libmrbus

$(MRTS)/libmrts.a: FORCE
	$(MAKE) -C $(MRTS) libmrts.a

FORCE:

mr-bus-fanout: main.cpp $(MRTS_HDRS) ../libmrbus/libmrbus.a $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) main.cpp ../libmrbus/libmrbus.a $(MRTS)/libmrts.a -o $@

test:
	@# Protocol conformance runs from vitest (unixfdFanout.test.ts).

clean:
	rm -f mr-bus-fanout

install: mr-bus-fanout
	install -D -m 755 mr-bus-fanout $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/mr-bus-fanout

else
all test clean install:
	@# Linux-only (memfd_create, SCM_RIGHTS) — skipped on this platform.
endif

.PHONY: all test clean install
