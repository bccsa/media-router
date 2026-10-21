# mrducker: libgstmrducker.so, audio-processing's ducker and the keyed gate's PTS keeper (plan
# ch. 6 WI-P2-10), loaded by path by both runners (native_plugins.cpp, gst_native_plugins.py).
# The envelope and the sample path (ducker_envelope.*) are plain C++, tested without GStreamer.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra
# A shared object needs PIC under a command-line CXXFLAGS too, as in mrts/Makefile.
override CXXFLAGS += -fPIC
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= audio-processing

# libgst<name>.so: GStreamer derives the entry symbol (gst_plugin_mrducker_get_desc) from it.
SO   = libgstmrducker.so
SRCS = gstmrducker.cpp gstmrptskeep.cpp ducker_envelope.cpp
HDRS = ducker_envelope.h mrducker_abi.h
# The core against duckerEnvelope.ts's vectors; never installed (under tests/).
TEST = tests/ducker_envelope_test
# gstreamer-audio-1.0 for mrptskeep's frame sizes (GstAudioInfo).
PKGS = gstreamer-1.0 gstreamer-base-1.0 gstreamer-audio-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

# -z defs: a symbol missing here fails this link, not the runner's load.
$(SO): $(SRCS) $(HDRS)
	$(CXX) $(CXXFLAGS) $(GST_CFLAGS) -shared -Wl,-z,defs $(SRCS) $(GST_LIBS) -o $@

# The same plugin built stale (MRDUCKER_ABI 0), never installed: the runners' loader test
# (gst_native_plugins_test.py) must see it refused. Under tests/, so it stays off boxes.
STUB = tests/abi0/$(SO)
stub: $(STUB)
$(STUB): $(SRCS) $(HDRS)
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -DMRDUCKER_ABI=0 $(GST_CFLAGS) -shared -Wl,-z,defs $(SRCS) $(GST_LIBS) \
	    -o $@

# Builds the plugin too, so native-test fails on a plugin that does not link. Its dataflow
# runs from plugins/audio-processing/py/mrducker_element_test.py (the plugin's test:py).
test: $(SO) $(STUB) $(TEST)
	./$(TEST)

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else
all stub install:
	@echo "mrducker: gstreamer-1.0/-base-1.0/-audio-1.0 dev packages not found — skipped"

test: $(TEST)
	./$(TEST)
endif

$(TEST): tests/ducker_envelope_test.cpp tests/ducker_vectors.inc ducker_envelope.cpp $(HDRS)
	$(CXX) $(CXXFLAGS) $< ducker_envelope.cpp -o $@

clean:
	rm -f $(SO) $(TEST)
	rm -rf tests/abi0

.PHONY: all test stub clean install
