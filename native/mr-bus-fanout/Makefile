# mr-bus-fanout — native GstUnixFd fan-out sidecar (drop-in replacement for
# unixfd-fanout.py). Linux-only.
CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra
PREFIX   ?= /usr/local

all: mr-bus-fanout

../libmrbus/libmrbus.a:
	$(MAKE) -C ../libmrbus

mr-bus-fanout: main.cpp ../libmrbus/libmrbus.a
	$(CXX) $(CXXFLAGS) main.cpp ../libmrbus/libmrbus.a -o $@

test:
	@# Protocol conformance runs from vitest (unixfdFanout.test.ts).

clean:
	rm -f mr-bus-fanout

install: mr-bus-fanout
	install -D -m 755 mr-bus-fanout $(DESTDIR)$(PREFIX)/bin/mr-bus-fanout

.PHONY: all test clean install
