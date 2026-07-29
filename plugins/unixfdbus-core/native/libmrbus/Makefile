# libmrbus — shared GstUnixFd bus transport (Linux-only: memfd_create,
# SCM_RIGHTS fd passing). Conformance-tested by unixfdFanout.test.ts against
# the same protocol clients as the python reference sidecar.
CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra

ifeq ($(shell uname -s),Linux)

OBJS = control.o fanout_server.o ingest.o bus_client.o

all: libmrbus.a

libmrbus.a: $(OBJS)
	$(AR) rcs $@ $(OBJS)

%.o: %.cpp busproto.h control.h fanout_server.h ingest.h bus_client.h
	$(CXX) $(CXXFLAGS) -c $< -o $@

test:
	@# Protocol conformance runs from vitest (unixfdFanout.test.ts).

clean:
	rm -f $(OBJS) libmrbus.a

install:
	@# Library is linked statically into the binaries; nothing to install.

else
all test clean install:
	@# Linux-only (memfd_create, SCM_RIGHTS) — skipped on this platform.
endif

.PHONY: all test clean install
