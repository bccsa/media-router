# mr-gst-runner — the native (C++) GStreamer pipeline runner, a per-module
# alternative to `gst-pipeline-runner.py` speaking the identical stdin/stderr
# JSON protocol (ADR-0019). Linux/GStreamer only.
#
# Deps: gstreamer-1.0 (core + base for pad probes / basetransform), glib
# (main loop, unix signals) and json-glib for the protocol — a runtime library
# of its own; the Yocto recipe lists it in DEPENDS and RDEPENDS.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra -Wno-deprecated-declarations -pthread
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
# The root Makefile passes the owning folder; for packages/engine it is
# `engine`, so the binary installs to /usr/libexec/media-router/engine/.
MR_PLUGIN  ?= engine

BIN  = mr-gst-runner
# The branch aligner and the TS video-info probe read TS the way the python
# runner does, through mpegts-core's `ts_psi`/`ts_timeline`/`ts_video_info`:
# the same sources are compiled in, exactly as mrtsstamp does — one
# definition, no TS arithmetic of the runner's own (ADR-0002 exception 3).
MR_PLUGINS_DIR ?= ../../../../plugins
MRTS = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/mpegts-core/native

SRCS = main.cpp ipc.cpp json_util.cpp runner.cpp commands.cpp stamper.cpp \
       bus_edges.cpp source_gate.cpp branch_align.cpp backlog_shed.cpp hooks.cpp \
       pad_link.cpp gates.cpp paths.cpp \
       $(MRTS)/ts_psi.cpp $(MRTS)/ts_timeline.cpp $(MRTS)/ts_video_info.cpp $(MRTS)/sps_parse.cpp
HDRS = ipc.h json_util.h runner.h stamper.h bus_edges.h source_gate.h \
       branch_align.h backlog_shed.h hooks.h mr_hook.h pad_link.h gates.h $(MRTS)/ts_psi.h $(MRTS)/ts_timeline.h
PKGS = gstreamer-1.0 gstreamer-base-1.0 glib-2.0 gio-2.0 json-glib-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

PKG_CFLAGS := $(shell pkg-config --cflags $(PKGS))
PKG_LIBS   := $(shell pkg-config --libs $(PKGS)) -ldl

all: $(BIN)

$(BIN): $(SRCS) $(HDRS)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(PKG_CFLAGS) $(SRCS) $(PKG_LIBS) -o $@

test:
	@# Protocol conformance runs from the python gst suite
	@# (packages/engine/src/child-process/native_runner_protocol_test.py, in test:py).

clean:
	rm -f $(BIN)

install: $(BIN)
	install -D -m 755 $(BIN) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(BIN)

else
all test clean install:
	@echo "mr-gst-runner: gstreamer-1.0/gstreamer-base-1.0/json-glib-1.0 dev packages not found — skipped"
endif

.PHONY: all test clean install
