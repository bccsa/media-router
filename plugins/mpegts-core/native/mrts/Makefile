# mrts — portable MPEG-TS packet core (no OS-specific includes).
# Standard conventions: respects CXX/CXXFLAGS/DESTDIR/PREFIX from the caller.
CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra
# PIC under a command-line CXXFLAGS too (build-native-dev.sh): the GStreamer plugins
# link this archive into a .so, and a non-PIC one left by such a build fails their
# next host link ("recompile with -fPIC") while make still sees it as up to date.
override CXXFLAGS += -fPIC

OBJS  = ts_house.o ts_packet.o ts_psi.o ts_split.o ts_video_info.o sps_parse.o ts_timeline.o \
        lateness.o ts_pcr.o ts_pes.o ts_stc.o ts_trace.o ts_restamp.o asrc_servo.o ts_gap.o align_watch.o
TESTS = tests/ts_house_test tests/ts_packet_test tests/ts_psi_test tests/ts_split_test \
        tests/ts_video_info_test tests/ts_timeline_test tests/lateness_test tests/ts_pcr_test tests/ts_pes_test tests/ts_stc_test \
        tests/ts_trace_test tests/ts_restamp_test tests/asrc_servo_test tests/ts_gap_test tests/align_watch_test
# Built with the tests so it keeps compiling; run by hand (WI-S0-11), never by `test`.
BENCH = tests/mrts_bench
# Built with the tests for trace_cli_test.sh; never run as one (no arguments: exit 2).
GEN = tests/fixture_gen

all: libmrts.a mrts_cli

libmrts.a: $(OBJS)
	$(AR) rcs $@ $(OBJS)

%.o: %.cpp ts_house.h ts_packet.h ts_psi.h ts_split.h ts_video_info.h sps_parse.h ts_timeline.h \
          lateness.h ts_pcr.h ts_pes.h ts_stc.h ts_trace.h ts_restamp.h asrc_servo.h ts_gap.h align_watch.h
	$(CXX) $(CXXFLAGS) -c $< -o $@

mrts_cli: mrts_cli.cpp libmrts.a
	$(CXX) $(CXXFLAGS) $< libmrts.a -o $@

tests/%: tests/%.cpp tests/check.h tests/trace_gen.h libmrts.a
	$(CXX) $(CXXFLAGS) $< libmrts.a -o $@

test: $(TESTS) $(BENCH) $(GEN) mrts_cli
	@for t in $(TESTS); do ./$$t || exit 1; done
	@sh tests/trace_cli_test.sh

clean:
	rm -f $(OBJS) libmrts.a mrts_cli $(TESTS) $(BENCH) $(GEN)

install:
	@# mrts ships no standalone binaries; mrts_cli is a test harness only.

.PHONY: all test clean install
