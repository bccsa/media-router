# mrtsstamp — GStreamer plugin wrapping mrts::TimelineStamper (the time-sync
# contract's producer-side egress stamper, ADR-0005). Linux/GStreamer only.
#
# The mrts sources are compiled INTO the .so rather than linked from
# libmrts.a: the archive is built without -fPIC (it only ever goes into
# executables), and pulling non-PIC objects into a shared object fails to link
# on aarch64. Same source files, one extra compile.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra -fPIC
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= mpegts-core

MR_PLUGINS_DIR ?= ../../..
MRTS = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/mpegts-core/native

# The filename is load-bearing: GStreamer derives the plugin entry symbol
# (gst_plugin_mrtsstamp_get_desc) from `libgst<name>.so`.
SO   = libgstmrtsstamp.so
SRCS = gstmrtsstamp.cpp $(MRTS)/ts_timeline.cpp $(MRTS)/ts_psi.cpp
PKGS = gstreamer-1.0 gstreamer-base-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

$(SO): $(SRCS) $(MRTS)/ts_timeline.h $(MRTS)/ts_psi.h
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(GST_CFLAGS) -shared $(SRCS) $(GST_LIBS) -o $@

test:
	@# Dataflow coverage runs from the python gst suite
	@# (packages/engine/src/child-process/gst_mrtsstamp_element_test.py, in test:py);
	@# the arithmetic itself is pinned by mrts/tests/ts_timeline_test.

clean:
	rm -f $(SO)

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else
all test clean install:
	@echo "mrtsstamp: gstreamer-1.0/gstreamer-base-1.0 dev packages not found — skipped"
endif

.PHONY: all test clean install
