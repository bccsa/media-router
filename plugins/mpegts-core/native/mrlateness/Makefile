# mrlateness — GStreamer pass-through tap reporting lateness per window, built
# on mrts::LatenessWindow (house-clock plan WI-P0-7). Linux/GStreamer only.
#
# Like mrtsstamp, the mrts source it needs is compiled INTO the .so (libmrts.a
# is built without -fPIC), so it has no build-order dependency on mrts.
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
SRCS = gstmrlateness.cpp $(MRTS)/lateness.cpp
PKGS = gstreamer-1.0

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

$(SO): $(SRCS) $(MRTS)/lateness.h
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(GST_CFLAGS) -shared $(SRCS) $(GST_LIBS) -o $@

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
