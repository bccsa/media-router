# mrlateness: GStreamer pass-through tap reporting lateness per window on mrts::LatenessWindow
# (WI-P0-7). Links the mrts core as the PIC archive libmrts.a, like every mrts user
# (WI-S0-6). Linux/GStreamer only.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra -fPIC
PREFIX     ?= /usr/local
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= mpegts-core

MR_PLUGINS_DIR ?= ../../..
MRTS = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/mpegts-core/native

# libgst<name>.so: GStreamer derives the entry symbol from the filename.
SO   = libgstmrlateness.so
SRCS = gstmrlateness.cpp
PKGS = gstreamer-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

$(SO): $(SRCS) $(MRTS)/lateness.h $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(GST_CFLAGS) -shared $(SRCS) $(MRTS)/libmrts.a $(GST_LIBS) -o $@

# mrts decides whether its archive is stale, whatever order the root Makefile
# reaches the directories in; the .so relinks only when the archive changed.
$(MRTS)/libmrts.a: FORCE
	$(MAKE) -C $(MRTS) libmrts.a
FORCE:

test:
	@# The window maths is pinned by mrts/tests/lateness_test; dataflow by
	@# packages/engine/src/child-process/gst_mrlateness_element_test.py (test:py).

clean:
	rm -f $(SO)

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else
all test clean install:
	@echo "mrlateness: gstreamer-1.0 dev package not found — skipped"
endif

.PHONY: all test clean install
