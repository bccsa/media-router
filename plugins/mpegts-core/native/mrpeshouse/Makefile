# mrpeshouse — GStreamer element running the subtitle bridge's per-packet walk
# (private PES assembly + the floor model) natively; the python bridge
# (plugins/subtitle-core/py) loads it by path. Linux/GStreamer only.
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
SO    = libgstmrpeshouse.so
CORE  = pes_walk.cpp stamp_model.cpp $(MRTS)/ts_psi.cpp
HDRS  = pes_walk.h stamp_model.h $(MRTS)/ts_psi.h
SRCS  = gstmrpeshouse.cpp $(CORE)
TESTS = tests/stamp_model_test
PKGS  = gstreamer-1.0 gstreamer-base-1.0
.DEFAULT_GOAL := all

# The model test needs no GStreamer: it runs wherever native-test runs.
tests/stamp_model_test: tests/stamp_model_test.cpp stamp_model.cpp stamp_model.h $(MRTS)/tests/check.h
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $< stamp_model.cpp -o $@

test: $(TESTS)
	@# Model parity (vectors dumped by subtitle-core/py/subtitle_stamp_dump.py); the
	@# walk + element are pinned by subtitle-core/py/subtitle_peshouse_gst_test.py.
	cd tests && ./stamp_model_test stamp_model_vectors.txt

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

$(SO): $(SRCS) $(HDRS)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(GST_CFLAGS) -shared $(SRCS) $(GST_LIBS) -o $@

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else
all install:
	@echo "mrpeshouse: gstreamer-1.0/gstreamer-base-1.0 dev packages not found — skipped"
endif

clean:
	rm -f $(SO) $(TESTS)

.PHONY: all test clean install
