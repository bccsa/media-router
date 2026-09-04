# mrrist — GStreamer plugin with `mrristsink` / `mrristsrc`: the RIST bridge on
# librist as native elements (replaces the runner's python appsink/appsrc
# drain, see gstmrrist.cpp). Linux/GStreamer only; needs the librist headers
# (recipe DEPENDS librist; dev boxes: librist-dev).
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra -fPIC
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= rist-core

# The filename is load-bearing: GStreamer derives the plugin entry symbol
# (gst_plugin_mrrist_get_desc) from `libgst<name>.so`.
SO   = libgstmrrist.so
SRCS = gstmrrist.cpp mrrist_common.cpp gstmrristsink.cpp gstmrristsrc.cpp
HDRS = mrrist_common.h
PKGS = gstreamer-1.0 gstreamer-base-1.0 librist

ifeq ($(shell pkg-config --exists $(PKGS) 2>/dev/null && echo yes),yes)

GST_CFLAGS := $(shell pkg-config --cflags $(PKGS))
GST_LIBS   := $(shell pkg-config --libs $(PKGS))

all: $(SO)

$(SO): $(SRCS) $(HDRS)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(GST_CFLAGS) -shared $(SRCS) $(GST_LIBS) -ldl -o $@

test:
	@# Dataflow coverage runs from the python gst suite
	@# (packages/engine/src/child-process/gst_mrrist_element_test.py, in test:py).

install: $(SO)
	install -D -m 755 $(SO) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(SO)

else

# No silent skip: the RIST modules have no fallback for these elements, so a
# build without the dev packages must FAIL here rather than ship an image whose
# RIST pipelines die at parse ("no element mrristsink"). Only `clean` (below,
# outside the guard) stays usable so `make native-clean` works everywhere.
all install:
	@echo "mrrist: ERROR — pkg-config cannot find $(PKGS); install the gstreamer/librist dev packages (recipe: DEPENDS librist)" >&2; exit 1
test:
	@echo "mrrist: skipping tests — pkg-config cannot find $(PKGS)"

endif

clean:
	rm -f $(SO)

.PHONY: all test clean install
