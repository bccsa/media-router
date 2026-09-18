# subtitle-bridge — the native form of the subtitle-core runner hook
# (`py/subtitle_bridge.py` is the reference): `libmrhook_subtitle_bridge.so`, loaded
# by mr-gst-runner through the `mr_hook.h` ABI (ADR-0020). Linux/GStreamer only.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra -fPIC
PREFIX     ?= /usr/local
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= subtitle-core

# The hook ABI header lives with the runner (plugins depend on the engine,
# never the reverse — ADR-0002).
MR_PLUGINS_DIR ?= ../../..
CPPFLAGS += -I$(MR_PLUGINS_DIR)/../packages/engine/native/mr-gst-runner

SO   = libmrhook_subtitle_bridge.so
SRCS = subtitle_bridge.cpp
PKGS = gstreamer-1.0 glib-2.0 json-glib-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

PKG_CFLAGS := $(shell pkg-config --cflags $(PKGS))
PKG_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

$(SO): $(SRCS) subtitle_klv.h $(MR_PLUGINS_DIR)/../packages/engine/native/mr-gst-runner/mr_hook.h
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(PKG_CFLAGS) -shared $(SRCS) $(PKG_LIBS) -o $@

test:
	@# Behaviour is pinned black-box by the runner protocol suite
	@# (packages/engine/src/child-process/native_runner_protocol_test.py);
	@# the python reference by py/subtitle_bridge_test.py.

clean:
	rm -f $(SO)

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else
all test clean install:
	@echo "subtitle-bridge: gstreamer-1.0/json-glib-1.0 dev packages not found — skipped"
endif

.PHONY: all test clean install
