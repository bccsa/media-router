# mr-tssplit — native TS splitter child (mrts core + libmrbus transport).
# Linux-only (bus transport).
CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra
PREFIX   ?= /usr/local

all: mr-tssplit

../libmrbus/libmrbus.a:
	$(MAKE) -C ../libmrbus

../mrts/libmrts.a:
	$(MAKE) -C ../mrts libmrts.a

mr-tssplit: main.cpp app.cpp app.h ../libmrbus/libmrbus.a ../mrts/libmrts.a
	$(CXX) $(CXXFLAGS) main.cpp app.cpp ../libmrbus/libmrbus.a ../mrts/libmrts.a -o $@

test:
	@# End-to-end coverage runs from vitest (mrTssplit.test.ts).

clean:
	rm -f mr-tssplit

install: mr-tssplit
	install -D -m 755 mr-tssplit $(DESTDIR)$(PREFIX)/bin/mr-tssplit

.PHONY: all test clean install
