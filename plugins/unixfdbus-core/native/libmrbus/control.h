// Control-plane plumbing shared by the native bus binaries: JSON-line events
// on stdout, JSON-line verbs on (non-blocking) stdin, and a minimal flat-
// object parser — the same contract as gst-pipeline-runner.py's control
// verbs, so UnixFdFanoutController drives either implementation unchanged.
#pragma once
#include <map>
#include <string>
#include <vector>

namespace mrbus {

// Monotonic clock in ns (pts timebase + all internal deadlines).
int64_t mono_ns();

std::string json_escape(const std::string& s);

// Write one JSON line to stdout and flush. Returns false when stdout is gone
// (engine died) — callers should exit quietly, python-sidecar parity.
bool emit_line(const std::string& json);

// Parse a flat JSON object of string/number/bool members ({"cmd":"bus_attach",
// "socket":"/tmp/x"}). Nested values are not supported (none exist in the
// control protocol); returns false on malformed input. Number/bool/null
// values are stored as their raw literal text.
bool parse_flat_json(const std::string& line, std::map<std::string, std::string>& out);

// Accumulates stdin bytes and yields complete newline-terminated lines
// (a control line can arrive split across reads — a fragment parsed alone
// would be silently dropped).
class LineReader {
  public:
    // Drain the fd. Complete lines land in `lines`. Returns false on EOF.
    bool read_lines(int fd, std::vector<std::string>& lines);

  private:
    std::string buf_;
};

}  // namespace mrbus
