# mr-tssplit — native TS splitter child (mrts core + libmrbus transport).
# Linux-only (bus transport). Links static archives from the unixfdbus-core and
# mpegts-core library plugins; MR_PLUGINS_DIR points at the plugins root.
CXX        ?= c++
CXXFLAGS   ?= -O2
CXXFLAGS   += -std=c++17 -Wall -Wextra
PREFIX     ?= /usr/local
# Overridable so packaging can pin the exact distro libexec dir (Yocto passes
# LIBEXECDIR=${libexecdir}); the default matches stock FHS layouts.
LIBEXECDIR ?= $(PREFIX)/libexec
MR_PLUGIN  ?= ts-splitter

MR_PLUGINS_DIR ?= ../../..
MRBUS = $(MR_PLUGINS_DIR)/unixfdbus-core/native/libmrbus
MRTS  = $(MR_PLUGINS_DIR)/mpegts-core/native/mrts
CPPFLAGS += -I$(MR_PLUGINS_DIR)/unixfdbus-core/native -I$(MR_PLUGINS_DIR)/mpegts-core/native
MRTS_HDRS = $(addprefix $(MRTS)/,lateness.h ts_split.h ts_psi.h ts_house.h ts_packet.h ts_pcr.h \
              ts_pes.h ts_video_info.h sps_parse.h ts_timeline.h)

ifeq ($(shell uname -s),Linux)

all: mr-tssplit

# Each library decides whether its archive is stale, whatever order the root
# Makefile reaches the directories in; mr-tssplit relinks only when one changed.
$(MRBUS)/libmrbus.a: FORCE
	$(MAKE) -C $(MRBUS)

$(MRTS)/libmrts.a: FORCE
	$(MAKE) -C $(MRTS) libmrts.a

FORCE:

mr-tssplit: main.cpp app.cpp app.h $(MRTS_HDRS) $(MRBUS)/libmrbus.a $(MRTS)/libmrts.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) main.cpp app.cpp $(MRBUS)/libmrbus.a $(MRTS)/libmrts.a -o $@

test:
	@# End-to-end coverage runs from vitest (mrTssplit.test.ts).

clean:
	rm -f mr-tssplit

install: mr-tssplit
	install -D -m 755 mr-tssplit $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/mr-tssplit

else
all test clean install:
	@# Linux-only (bus transport) — skipped on this platform.
endif

.PHONY: all test clean install
