# mrtshouse: libgstmrtshouse.so, the one GStreamer plugin of the house-clock elements (plan
# ch. 3 WI-S0-7), loaded by path by both runners. Links the mrts core as the PIC archive
# libmrts.a, like every mrts user (WI-S0-6). Linux/GStreamer only.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra
# A shared object needs PIC under a command-line CXXFLAGS too, as in mrts/Makefile.
override CXXFLAGS += -fPIC
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= mpegts-core

MR_PLUGINS_DIR ?= ../../..
MRTS = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/mpegts-core/native

# libgst<name>.so: GStreamer derives the entry symbol (gst_plugin_mrtshouse_get_desc) from it.
SO   = libgstmrtshouse.so
# One file per element: a phase adds its source here and its row to gstmrtshouse.cpp.
SRCS = gstmrtshouse.cpp gstmrtsrestamp.cpp
HDRS = mrtshouse.h mrtshouse_abi.h $(MRTS)/ts_packet.h $(MRTS)/ts_restamp.h $(MRTS)/ts_stc.h \
       $(MRTS)/ts_trace.h $(MRTS)/ts_gap.h
# Phase 1 adds gstreamer-audio-1.0 (mrasrc); Phase 3 gstreamer-mpegts-1.0 (section messages).
PKGS = gstreamer-1.0 gstreamer-base-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

# -z defs: a symbol missing from the archive fails this link, not the runner's load.
$(SO): $(SRCS) $(HDRS) $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(GST_CFLAGS) -shared -Wl,-z,defs $(SRCS) $(MRTS)/libmrts.a \
	    $(GST_LIBS) -o $@

# mrts decides whether its archive is stale, whatever order the root Makefile
# reaches the directories in; the .so relinks only when the archive changed.
$(MRTS)/libmrts.a: FORCE
	$(MAKE) -C $(MRTS) libmrts.a
FORCE:

# The same plugin built stale (MRTSHOUSE_ABI 0), never installed: the runners' loader tests
# (gst_native_plugins_test.py, WI-S0-8) must see it refused. Under tests/, so it stays off boxes.
STUB = tests/abi0/$(SO)
stub: $(STUB)
$(STUB): $(SRCS) $(HDRS) $(MRTS)/libmrts.a
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -DMRTSHOUSE_ABI=0 $(GST_CFLAGS) -shared -Wl,-z,defs $(SRCS) \
	    $(MRTS)/libmrts.a $(GST_LIBS) -o $@

# What mrts::RestampCore makes of a buffer sequence, which gst_mrtsrestamp_element_test.py and
# gst_ingest_restamp_test.py hold the element and the runners to. GStreamer-free, never
# installed; under tests/, so it stays off boxes.
REF = tests/restamp_ref
$(REF): tests/restamp_ref.cpp $(MRTS)/ts_restamp.h $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $< $(MRTS)/libmrts.a -o $@

# Builds the plugin, so native-test fails on a plugin that does not link. Its contract and
# dataflow run from packages/engine/src/child-process/gst_mrtshouse_element_test.py,
# gst_mrtsrestamp_element_test.py and gst_ingest_restamp_test.py (test:py).
test: $(SO) $(STUB) $(REF)

clean:
	rm -f $(SO) $(REF)
	rm -rf $(dir $(STUB))

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else
all test stub clean install:
	@echo "mrtshouse: gstreamer-1.0/gstreamer-base-1.0 dev packages not found — skipped"
endif

.PHONY: all test stub clean install
