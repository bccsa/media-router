# libmrbus — shared GstUnixFd bus transport (Linux-only: memfd_create,
# SCM_RIGHTS fd passing). Conformance-tested by unixfdFanout.test.ts against
# the same protocol clients as the python reference sidecar.
CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra

OBJS = control.o fanout_server.o ingest.o

all: libmrbus.a

libmrbus.a: $(OBJS)
	$(AR) rcs $@ $(OBJS)

%.o: %.cpp busproto.h control.h fanout_server.h ingest.h
	$(CXX) $(CXXFLAGS) -c $< -o $@

test:
	@# Protocol conformance runs from vitest (unixfdFanout.test.ts).

clean:
	rm -f $(OBJS) libmrbus.a

install:
	@# Library is linked statically into the binaries; nothing to install.

.PHONY: all test clean install
