# Native media-router components. Plain make, C++17, libc/libstdc++ only —
# no third-party dependencies, no network fetch. Standard conventions:
#   make            build everything
#   make test       build + run the C++ test executables
#   make install    install binaries to $(DESTDIR)$(PREFIX)/bin
# Cross builds: pass CXX (e.g. CXX=aarch64-linux-gnu-g++) or use build-dev.sh.
#
# mrts is portable; the bus transport (libmrbus, mr-bus-fanout) needs Linux
# (memfd_create, SCM_RIGHTS) and is skipped elsewhere.
SUBDIRS = mrts
ifeq ($(shell uname -s),Linux)
SUBDIRS += libmrbus mr-bus-fanout mr-tssplit
endif

all test clean install:
	@for d in $(SUBDIRS); do $(MAKE) -C $$d $@ || exit 1; done

.PHONY: all test clean install
