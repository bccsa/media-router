# mrts — portable MPEG-TS packet core (no OS-specific includes).
# Standard conventions: respects CXX/CXXFLAGS/DESTDIR/PREFIX from the caller.
CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra

OBJS  = ts_psi.o ts_split.o ts_video_info.o sps_parse.o
TESTS = tests/ts_psi_test tests/ts_split_test tests/ts_video_info_test

all: libmrts.a mrts_cli

libmrts.a: $(OBJS)
	$(AR) rcs $@ $(OBJS)

%.o: %.cpp ts_psi.h ts_split.h ts_video_info.h sps_parse.h
	$(CXX) $(CXXFLAGS) -c $< -o $@

mrts_cli: mrts_cli.cpp libmrts.a
	$(CXX) $(CXXFLAGS) $< libmrts.a -o $@

tests/%: tests/%.cpp tests/check.h libmrts.a
	$(CXX) $(CXXFLAGS) $< libmrts.a -o $@

test: $(TESTS)
	@for t in $(TESTS); do ./$$t || exit 1; done

clean:
	rm -f $(OBJS) libmrts.a mrts_cli $(TESTS)

install:
	@# mrts ships no standalone binaries; mrts_cli is a test harness only.

.PHONY: all test clean install
