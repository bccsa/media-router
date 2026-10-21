// mrts_cli: test harness for the mrts core. Splitter mode writes out_0x<pid>.ts per output
// and JSON events, the contract py/native_parity_ref.py implements (nativeSplitParity.test.ts);
// `dump` prints every PES of the followed program, PSI events and counters as JSON lines.
// Usage: mrts_cli --outputs 0x100,0x140:0x0f[,...] [--chunk 1316]
//                 [--ts-id 1] --out-dir DIR input.ts
//        mrts_cli dump [--chunk 1316] [--program N] input.ts
//        mrts_cli trace2jsonl input.stct
//        mrts_cli jsonl2trace input.jsonl|- output.stct
//        mrts_cli restamp-replay input.stct [--config k=v...] [--sweep grid.json] [--expect file]
#include <algorithm>
#include <array>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ts_dump.h"
#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"
#include "ts_restamp.h"
#include "ts_split.h"
#include "ts_stc.h"
#include "ts_trace.h"

using namespace mrts;

namespace {

void emit_videoinfo(int pid, const VideoInfo& v) {
    std::string display = format_video_info(v);
    std::printf("{\"event\":\"videoinfo\",\"pid\":%d,\"codec\":\"%s\"", pid, v.codec);
    if (v.width) std::printf(",\"width\":%d", *v.width);
    if (v.height) std::printf(",\"height\":%d", *v.height);
    if (v.interlaced) std::printf(",\"interlaced\":%s", *v.interlaced ? "true" : "false");
    if (v.fps) std::printf(",\"fps\":%.6g", *v.fps);
    if (v.scrambled) std::printf(",\"scrambled\":true");
    if (!display.empty()) std::printf(",\"display\":\"%s\"", display.c_str());
    std::printf("}\n");
}

void emit_discovered(const std::vector<std::pair<int, int>>& streams, int pcr_pid,
                     const std::vector<std::pair<int, std::vector<uint8_t>>>& es_info) {
    std::printf("{\"event\":\"discovered\",\"streams\":[");
    for (size_t i = 0; i < streams.size(); i++)
        std::printf("%s[%d,%d]", i ? "," : "", streams[i].first, streams[i].second);
    std::printf("],\"pcrPid\":%d,\"esInfo\":[", pcr_pid);
    for (size_t i = 0; i < es_info.size(); i++) {
        std::printf("%s[%d,\"", i ? "," : "", es_info[i].first);
        for (uint8_t b : es_info[i].second) std::printf("%02x", b);
        std::printf("\"]");
    }
    std::printf("]}\n");
}

int dump_main(int argc, char** argv) {
    long chunk = 1316;
    int program = -1;
    std::string input;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--chunk" && i + 1 < argc) {
            chunk = std::atol(argv[++i]);
        } else if (a == "--program" && i + 1 < argc) {
            program = std::atoi(argv[++i]);
        } else if (a[0] != '-' && input.empty()) {
            input = a;
        } else {
            input.clear();
            break;
        }
    }
    if (input.empty() || chunk <= 0) {
        std::fprintf(stderr, "usage: mrts_cli dump [--chunk N] [--program N] input.ts\n");
        return 2;
    }
    FILE* f = std::fopen(input.c_str(), "rb");
    if (!f) {
        std::perror("open input");
        return 1;
    }
    std::vector<uint8_t> buf((size_t)chunk);
    PesIndex dump([](const std::string& line) { std::printf("%s\n", line.c_str()); }, program);
    size_t n;
    while ((n = std::fread(buf.data(), 1, buf.size(), f)) > 0) dump.feed(buf.data(), n);
    const bool failed = std::ferror(f);
    std::fclose(f);
    if (failed) {
        std::perror("read input");
        return 1;
    }
    dump.finish();
    return 0;
}


// --- JSON in: jsonl2trace lines, --expect and --sweep files ---------------------------

struct Json {
    enum class Type { null, boolean, number, string, array, object };
    Type type = Type::null;
    bool b = false;
    std::string s;                                    // a string; a number's text
    std::vector<Json> items;                          // array
    std::vector<std::pair<std::string, Json>> keys;   // object, in file order
    const Json* get(const std::string& k) const {
        for (const auto& kv : keys)
            if (kv.first == k) return &kv.second;
        return nullptr;
    }
    bool integer() const { return type == Type::number && s.find_first_of(".eE") == std::string::npos; }
    bool i64(int64_t* v) const {
        if (!integer()) return false;
        errno = 0;
        char* end = nullptr;
        const long long x = std::strtoll(s.c_str(), &end, 10);
        if (errno || *end) return false;
        *v = x;
        return true;
    }
    bool u64(uint64_t* v) const {
        if (!integer() || s[0] == '-') return false;
        errno = 0;
        char* end = nullptr;
        const unsigned long long x = std::strtoull(s.c_str(), &end, 10);
        if (errno || *end) return false;
        *v = x;
        return true;
    }
    bool f64(double* v) const {
        if (type != Type::number) return false;
        *v = std::strtod(s.c_str(), nullptr);
        return true;
    }
};

class JsonParser {
  public:
    JsonParser(const char* p, size_t n) : p_(p), begin_(p), end_(p + n) {}
    bool parse(Json* out, std::string* err) {
        skip();
        bool ok = value(out, 0);
        if (ok) {
            skip();
            if (p_ != end_) ok = fail("trailing characters");
        }
        if (!ok) *err = err_ + " at byte " + std::to_string(p_ - begin_);
        return ok;
    }

  private:
    bool fail(const char* why) {
        if (err_.empty()) err_ = why;
        return false;
    }
    void skip() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\r' || *p_ == '\n')) p_++;
    }
    bool word(const char* w) {
        const size_t n = std::strlen(w);
        if ((size_t)(end_ - p_) < n || std::memcmp(p_, w, n) != 0) return false;
        p_ += n;
        return true;
    }
    bool digits() {
        const char* s = p_;
        while (p_ < end_ && *p_ >= '0' && *p_ <= '9') p_++;
        return p_ > s;
    }
    bool hex4(uint32_t* v) {
        if (end_ - p_ < 4) return false;
        *v = 0;
        for (int i = 0; i < 4; i++) {
            const char c = *p_++;
            const int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
                                                         : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
            if (d < 0) return false;
            *v = *v * 16 + (uint32_t)d;
        }
        return true;
    }
    bool string(std::string* out) {
        p_++;
        while (p_ < end_ && *p_ != '"') {
            const unsigned char c = (unsigned char)*p_++;
            if (c < 0x20) return fail("control character in a string");
            if (c != '\\') {
                out->push_back((char)c);
                continue;
            }
            if (p_ == end_) break;
            const char e = *p_++;
            uint32_t cp = 0;
            switch (e) {
                case '"': case '\\': case '/': out->push_back(e); continue;
                case 'b': out->push_back('\b'); continue;
                case 'f': out->push_back('\f'); continue;
                case 'n': out->push_back('\n'); continue;
                case 'r': out->push_back('\r'); continue;
                case 't': out->push_back('\t'); continue;
                case 'u':
                    if (!hex4(&cp)) return fail("bad \\u escape");
                    break;
                default:
                    return fail("bad escape");
            }
            if (cp >= 0xD800 && cp < 0xDC00) {   // a surrogate pair
                uint32_t lo = 0;
                if (!word("\\u") || !hex4(&lo) || lo < 0xDC00 || lo >= 0xE000) return fail("bad surrogate pair");
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
            if (cp < 0x80) {
                out->push_back((char)cp);
            } else if (cp < 0x800) {
                out->push_back((char)(0xC0 | (cp >> 6)));
                out->push_back((char)(0x80 | (cp & 0x3F)));
            } else if (cp < 0x10000) {
                out->push_back((char)(0xE0 | (cp >> 12)));
                out->push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
                out->push_back((char)(0x80 | (cp & 0x3F)));
            } else {
                out->push_back((char)(0xF0 | (cp >> 18)));
                out->push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
                out->push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
                out->push_back((char)(0x80 | (cp & 0x3F)));
            }
        }
        if (p_ == end_) return fail("unterminated string");
        p_++;
        return true;
    }
    bool value(Json* v, int depth) {
        if (depth > 32) return fail("nested too deep");
        if (p_ == end_) return fail("unexpected end");
        if (*p_ == '{' || *p_ == '[') {
            const bool obj = *p_++ == '{';
            const char close = obj ? '}' : ']';
            v->type = obj ? Json::Type::object : Json::Type::array;
            skip();
            if (p_ < end_ && *p_ == close) {
                p_++;
                return true;
            }
            while (true) {
                skip();
                std::string k;
                if (obj) {
                    if (p_ == end_ || *p_ != '"' || !string(&k)) return fail("expected a key");
                    skip();
                    if (p_ == end_ || *p_ != ':') return fail("expected ':'");
                    p_++;
                    skip();
                }
                Json item;
                if (!value(&item, depth + 1)) return false;
                if (obj) v->keys.emplace_back(std::move(k), std::move(item));
                else v->items.push_back(std::move(item));
                skip();
                if (p_ < end_ && *p_ == ',') {
                    p_++;
                    continue;
                }
                if (p_ < end_ && *p_ == close) {
                    p_++;
                    return true;
                }
                return fail(obj ? "expected ',' or '}'" : "expected ',' or ']'");
            }
        }
        if (*p_ == '"') {
            v->type = Json::Type::string;
            return string(&v->s);
        }
        if (word("true") || word("false")) {
            v->type = Json::Type::boolean;
            v->b = p_[-1] == 'e' && p_[-2] == 'u';
            return true;
        }
        if (word("null")) return true;
        const char* s = p_;
        if (p_ < end_ && *p_ == '-') p_++;
        if (p_ == end_ || *p_ < '0' || *p_ > '9') return fail("expected a value");
        if (*p_ == '0') p_++;
        else digits();
        if (p_ < end_ && *p_ == '.' && (++p_, !digits())) return fail("bad number");
        if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
            p_++;
            if (p_ < end_ && (*p_ == '+' || *p_ == '-')) p_++;
            if (!digits()) return fail("bad number");
        }
        v->type = Json::Type::number;
        v->s.assign(s, p_);
        return true;
    }

    const char* p_;
    const char* begin_;
    const char* end_;
    std::string err_;
};

bool parse_json(const std::string& text, Json* out, std::string* err) {
    return JsonParser(text.data(), text.size()).parse(out, err);
}

bool read_file(const std::string& path, std::string* out) {
    std::FILE* f = path == "-" ? stdin : std::fopen(path.c_str(), "rb");
    if (!f) return false;
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out->append(buf, n);
    const bool ok = !std::ferror(f);
    if (f != stdin) std::fclose(f);
    return ok;
}

std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (const unsigned char c : s) {
        if (c == '"' || c == '\\') {
            o += '\\';
            o += (char)c;
        } else if (c < 0x20) {
            char b[8];
            std::snprintf(b, sizeof b, "\\u%04x", c);
            o += b;
        } else {
            o += (char)c;
        }
    }
    return o + "\"";
}

// --- trace2jsonl / jsonl2trace: .stct <-> one JSON object per record (WI-P1-2) ---------

const char* kind_name(TraceKind k) {
    switch (k) {
        case TraceKind::pcr: return "pcr";
        case TraceKind::pes: return "pes";
        case TraceKind::psi: return "psi";
        case TraceKind::outage: return "outage";
        default: return nullptr;
    }
}

const char* class_name(StreamClass c) {
    switch (c) {
        case StreamClass::other: return "other";
        case StreamClass::video: return "video";
        case StreamClass::audio: return "audio";
        default: return nullptr;
    }
}

constexpr uint64_t PSI_FIELDS = 0xFFFFFFULL | TRACE_PSI_PCR;   // program, stream_type, PCR mark

// Each record field once, the value under its kind's own name; lossless, so a line
// reads back to the same 24 bytes.
std::string record_json(const TraceRecord& r) {
    char b[160];
    std::string o;
    std::snprintf(b, sizeof b, "{\"t\":%lld,\"kind\":", (long long)r.arrival_ns);
    o = b;
    const char* kn = kind_name(r.kind);
    o += kn ? std::string("\"") + kn + "\"" : std::to_string((unsigned)r.kind);
    std::snprintf(b, sizeof b, ",\"pid\":%u", (unsigned)r.pid);
    o += b;
    const unsigned long long v = r.value;
    switch (r.kind) {
        case TraceKind::pcr: std::snprintf(b, sizeof b, ",\"pcr\":%llu", v); break;
        case TraceKind::pes:
            std::snprintf(b, sizeof b, ",\"pts\":%llu,\"dtsMinusPts\":%d", v, r.dts_minus_pts_90k);
            break;
        case TraceKind::psi: {
            std::snprintf(b, sizeof b, ",\"program\":%llu,\"streamType\":%llu,\"pcrPid\":%s", v & 0xFFFF,
                          (v >> 16) & 0xFF, (v & TRACE_PSI_PCR) ? "true" : "false");
            const size_t n = std::strlen(b);
            if (v & ~PSI_FIELDS) std::snprintf(b + n, sizeof b - n, ",\"valueRest\":%llu", v & ~PSI_FIELDS);
            break;
        }
        case TraceKind::outage: std::snprintf(b, sizeof b, ",\"silenceNs\":%llu", v); break;
        default: std::snprintf(b, sizeof b, ",\"value\":%llu", v); break;
    }
    o += b;
    if (r.kind != TraceKind::pes && r.dts_minus_pts_90k != 0) {
        std::snprintf(b, sizeof b, ",\"dtsMinusPts\":%d", r.dts_minus_pts_90k);
        o += b;
    }
    o += (r.flags & TRACE_FLAG_DISCONTINUITY) ? ",\"di\":true,\"class\":" : ",\"di\":false,\"class\":";
    const char* cn = class_name(trace_class(r.flags));
    o += cn ? std::string("\"") + cn + "\"" : std::to_string((unsigned)trace_class(r.flags));
    if (r.flags & 0xF8) o += ",\"flagsRest\":" + std::to_string((unsigned)(r.flags & 0xF8));
    return o + "}";
}

bool record_from_json(const Json& j, TraceRecord* out, std::string* err) {
    if (j.type != Json::Type::object) return *err = "not an object", false;
    TraceRecord r;
    int64_t i = 0;
    uint64_t u = 0;
    const Json* k = j.get("kind");
    if (!k) return *err = "no \"kind\"", false;
    if (k->type == Json::Type::string) {
        int found = 0;
        for (int n = 0; n < 256; n++)
            if (kind_name((TraceKind)n) && k->s == kind_name((TraceKind)n)) found = n;
        if (!found) return *err = "unknown kind \"" + k->s + "\"", false;
        r.kind = (TraceKind)found;
    } else if (k->u64(&u) && u <= 255 && !kind_name((TraceKind)u)) {
        r.kind = (TraceKind)u;   // a kind no recorder writes: kept as a number
    } else {
        return *err = "bad \"kind\"", false;
    }
    std::vector<std::string> allowed = {"t", "kind", "pid", "dtsMinusPts", "di", "class", "flagsRest"};
    auto need_u = [&](const char* key, uint64_t max, uint64_t* v) {
        allowed.push_back(key);
        const Json* x = j.get(key);
        if (!x || !x->u64(v) || *v > max) return *err = std::string("missing or bad \"") + key + "\"", false;
        return true;
    };
    const Json* t = j.get("t");
    if (!t || !t->i64(&i)) return *err = "missing or bad \"t\"", false;
    r.arrival_ns = i;
    if (!need_u("pid", 0xFFFF, &u)) return false;
    r.pid = (uint16_t)u;
    switch (r.kind) {
        case TraceKind::pcr:
            if (!need_u("pcr", UINT64_MAX, &r.value)) return false;
            break;
        case TraceKind::pes:
            if (!need_u("pts", UINT64_MAX, &r.value)) return false;
            break;
        case TraceKind::outage:
            if (!need_u("silenceNs", UINT64_MAX, &r.value)) return false;
            break;
        case TraceKind::psi: {
            uint64_t prog, type, rest = 0;
            if (!need_u("program", 0xFFFF, &prog) || !need_u("streamType", 0xFF, &type)) return false;
            allowed.push_back("pcrPid");
            allowed.push_back("valueRest");
            const Json* pcr = j.get("pcrPid");
            if (!pcr || pcr->type != Json::Type::boolean) return *err = "missing or bad \"pcrPid\"", false;
            const Json* x = j.get("valueRest");
            if (x && (!x->u64(&rest) || (rest & PSI_FIELDS))) return *err = "bad \"valueRest\"", false;
            r.value = prog | (type << 16) | (pcr->b ? TRACE_PSI_PCR : 0) | rest;
            break;
        }
        default:
            if (!need_u("value", UINT64_MAX, &r.value)) return false;
            break;
    }
    if (const Json* d = j.get("dtsMinusPts")) {
        if (!d->i64(&i) || i < INT32_MIN || i > INT32_MAX) return *err = "bad \"dtsMinusPts\"", false;
        r.dts_minus_pts_90k = (int32_t)i;
    }
    unsigned cls = 0, rest = 0;
    if (const Json* c = j.get("class")) {
        if (c->type == Json::Type::string) {
            cls = 4;
            for (unsigned n = 0; n < 3; n++)
                if (c->s == class_name((StreamClass)n)) cls = n;
        } else if (c->u64(&u) && u <= 3) {
            cls = (unsigned)u;
        } else {
            cls = 4;
        }
        if (cls > 3) return *err = "bad \"class\"", false;
    }
    if (const Json* f = j.get("flagsRest")) {
        if (!f->u64(&u) || u > 0xFF || (u & 0x07)) return *err = "bad \"flagsRest\"", false;
        rest = (unsigned)u;
    }
    const Json* di = j.get("di");
    if (di && di->type != Json::Type::boolean) return *err = "bad \"di\"", false;
    r.flags = (uint8_t)((di && di->b ? TRACE_FLAG_DISCONTINUITY : 0) | (cls << 1) | rest);
    for (const auto& kv : j.keys)
        if (std::find(allowed.begin(), allowed.end(), kv.first) == allowed.end())
            return *err = "unknown key \"" + kv.first + "\"", false;
    *out = r;
    return true;
}

// Every record of a trace; false when it cannot be opened. A damaged end is said on
// stderr and leaves the records before it.
bool read_trace(const std::string& path, std::vector<TraceRecord>* out, TraceReader::Status* status) {
    TraceReader rd;
    if (!rd.open(path)) {
        std::fprintf(stderr, "mrts_cli: %s: not an .stct version %u trace\n", path.c_str(), TRACE_VERSION);
        return false;
    }
    TraceRecord r;
    while (rd.next(&r)) out->push_back(r);
    *status = rd.status();
    if (rd.status() == TraceReader::Status::unclosed)
        std::fprintf(stderr, "mrts_cli: %s: never closed (count 0): %zu whole records\n", path.c_str(), out->size());
    else if (rd.status() == TraceReader::Status::truncated)
        std::fprintf(stderr, "mrts_cli: %s: truncated: %zu of %llu records\n", path.c_str(), out->size(),
                     (unsigned long long)rd.header_count());
    return true;
}

int trace2jsonl_main(int argc, char** argv) {
    if (argc != 2 || argv[1][0] == '-') {
        std::fprintf(stderr, "usage: mrts_cli trace2jsonl input.stct\n");
        return 2;
    }
    std::vector<TraceRecord> recs;
    TraceReader::Status st;
    if (!read_trace(argv[1], &recs, &st)) return 1;
    for (const TraceRecord& r : recs) std::printf("%s\n", record_json(r).c_str());
    return st == TraceReader::Status::truncated ? 1 : 0;
}

int jsonl2trace_main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: mrts_cli jsonl2trace input.jsonl|- output.stct\n");
        return 2;
    }
    std::string text;
    if (!read_file(argv[1], &text)) {
        std::perror(argv[1]);
        return 1;
    }
    std::vector<TraceRecord> recs;
    size_t line = 0;
    for (size_t at = 0; at < text.size();) {
        size_t nl = text.find('\n', at);
        if (nl == std::string::npos) nl = text.size();
        const std::string l = text.substr(at, nl - at);
        at = nl + 1;
        line++;
        if (l.find_first_not_of(" \t\r") == std::string::npos) continue;
        Json j;
        std::string err;
        TraceRecord r;
        if (!parse_json(l, &j, &err) || !record_from_json(j, &r, &err)) {
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", argv[1], line, err.c_str());
            return 1;
        }
        recs.push_back(r);
    }
    TraceWriter w;
    if (!w.open(argv[2])) {
        std::perror(argv[2]);
        return 1;
    }
    for (const TraceRecord& r : recs) w.write(r);
    if (!w.close()) {
        std::fprintf(stderr, "mrts_cli: writing %s failed\n", argv[2]);
        std::remove(argv[2]);
        return 1;
    }
    return 0;
}

// --- restamp-replay: a trace through RestampCore (WI-P1-2; the WI-P1-6 sweep) ----------

// Trace times are wire input: their differences saturate rather than overflow.
int64_t sat_sub(int64_t a, int64_t b) {
    if (b < 0 && a > INT64_MAX + b) return INT64_MAX;
    if (b > 0 && a < INT64_MIN + b) return INT64_MIN;
    return a - b;
}
int64_t sat_add(int64_t a, int64_t b) {
    if (b > 0 && a > INT64_MAX - b) return INT64_MAX;
    if (b < 0 && a < INT64_MIN - b) return INT64_MIN;
    return a + b;
}

bool parse_int(const std::string& s, int64_t* v) {
    if (s.empty()) return false;
    const bool hex = s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X');
    errno = 0;
    char* end = nullptr;
    const long long x = std::strtoll(s.c_str(), &end, hex ? 16 : 10);
    if (errno || *end) return false;
    *v = x;
    return true;
}

bool parse_flag(const std::string& s, bool* v) {
    if (s == "true" || s == "1") return *v = true, true;
    if (s == "false" || s == "0") return *v = false, true;
    return false;
}

struct Knob64 {
    const char* name;
    int64_t ClockLockConfig::*clock;
    int64_t PcrValidatorConfig::*pcr;
};
struct KnobInt {
    const char* name;
    int ClockLockConfig::*clock;
    int PcrValidatorConfig::*pcr;
};

// Every constant of ClockLockConfig and PcrValidatorConfig by its field name; the one
// name both carry (rate_max_ppm, part 4.3's single constant) sets both, unless
// prefixed clock. or pcr.
const Knob64 kKnobs64[] = {
    {"bucket_ns", &ClockLockConfig::bucket_ns, nullptr},
    {"rate_tau_ns", &ClockLockConfig::rate_tau_ns, nullptr},
    {"rate_warn_ppm", &ClockLockConfig::rate_warn_ppm, nullptr},
    {"rate_max_ppm", &ClockLockConfig::rate_max_ppm, &PcrValidatorConfig::rate_max_ppm},
    {"slew_acquire_ppm", &ClockLockConfig::slew_acquire_ppm, nullptr},
    {"acquire_ns", &ClockLockConfig::acquire_ns, nullptr},
    {"slew_track_ppm", &ClockLockConfig::slew_track_ppm, nullptr},
    {"step_ns", &ClockLockConfig::step_ns, nullptr},
    {"step_hold_ns", &ClockLockConfig::step_hold_ns, nullptr},
    {"backlog_ns", &ClockLockConfig::backlog_ns, nullptr},
    {"lost_ns", &ClockLockConfig::lost_ns, nullptr},
    {"residual_window_ns", &ClockLockConfig::residual_window_ns, nullptr},
    {"pcr_interval_warn_ns", nullptr, &PcrValidatorConfig::pcr_interval_warn_ns},
    {"pcr_interval_fail_ns", nullptr, &PcrValidatorConfig::pcr_interval_fail_ns},
    {"cadence_window_ns", nullptr, &PcrValidatorConfig::cadence_window_ns},
    {"cadence_fail_window_ns", nullptr, &PcrValidatorConfig::cadence_fail_window_ns},
    {"rate_hold_ns", nullptr, &PcrValidatorConfig::rate_hold_ns},
    {"freeze_min_dh_ns", nullptr, &PcrValidatorConfig::freeze_min_dh_ns},
    {"leap_ns", nullptr, &PcrValidatorConfig::leap_ns},
    {"leap_window_ns", nullptr, &PcrValidatorConfig::leap_window_ns},
    {"lead_min_ns", nullptr, &PcrValidatorConfig::lead_min_ns},
    {"lead_max_ns", nullptr, &PcrValidatorConfig::lead_max_ns},
    {"lead_median_window_ns", nullptr, &PcrValidatorConfig::lead_median_window_ns},
    {"lead_hold_ns", nullptr, &PcrValidatorConfig::lead_hold_ns},
    {"recover_ns", nullptr, &PcrValidatorConfig::recover_ns},
    {"lead_clamp_ns", nullptr, &PcrValidatorConfig::lead_clamp_ns},
};
const KnobInt kKnobsInt[] = {
    {"rate_buckets_min", &ClockLockConfig::rate_buckets_min, nullptr},
    {"rate_buckets_max", &ClockLockConfig::rate_buckets_max, nullptr},
    {"rate_refit_mads", &ClockLockConfig::rate_refit_mads, nullptr},
    {"offset_buckets", &ClockLockConfig::offset_buckets, nullptr},
    {"cadence_fail_count", nullptr, &PcrValidatorConfig::cadence_fail_count},
    {"freeze_count", nullptr, &PcrValidatorConfig::freeze_count},
    {"leap_fail_count", nullptr, &PcrValidatorConfig::leap_fail_count},
};

// One --config k=v (or sweep axis value) onto the configuration; false with *err.
bool set_knob(RestampConfig& c, const std::string& key, const std::string& v, std::string* err) {
    std::string k = key;
    bool clock = true, pcr = true, top = true;
    if (k.rfind("clock.", 0) == 0) {
        k = k.substr(6);
        pcr = top = false;
    } else if (k.rfind("pcr.", 0) == 0) {
        k = k.substr(4);
        clock = top = false;
    }
    bool found = false, ok = true;
    int64_t x = 0;
    for (const Knob64& n : kKnobs64) {
        if (k != n.name || !((clock && n.clock) || (pcr && n.pcr))) continue;
        found = true;
        ok = parse_int(v, &x);
        if (ok && clock && n.clock) c.clock.*n.clock = x;
        if (ok && pcr && n.pcr) c.pcr.*n.pcr = x;
    }
    for (const KnobInt& n : kKnobsInt) {
        if (k != n.name || !((clock && n.clock) || (pcr && n.pcr))) continue;
        found = true;
        ok = parse_int(v, &x) && x >= INT32_MIN && x <= INT32_MAX;
        if (ok && clock && n.clock) c.clock.*n.clock = (int)x;
        if (ok && pcr && n.pcr) c.pcr.*n.pcr = (int)x;
    }
    if (clock && k == "step_falls") {
        found = true;
        ok = parse_flag(v, &c.clock.step_falls);
    }
    if (top && k == "mode") {
        found = true;
        ok = v == "stc" || v == "fixed";
        c.mode = v == "fixed" ? RestampConfig::Mode::fixed : RestampConfig::Mode::stc;
    } else if (top && k == "add_base_time") {
        found = true;
        ok = parse_flag(v, &c.add_base_time);
    } else if (top && (k == "base_time_ns" || k == "offset_ns")) {
        found = true;
        ok = parse_int(v, k == "offset_ns" ? &c.offset_ns : &c.base_time_ns);
    } else if (top && k == "pid_trims") {
        // The element's pid-trims form: "<pid>=<ns>;..."
        found = true;
        c.trims_ns.clear();
        for (size_t at = 0; ok && at < v.size();) {
            size_t semi = v.find(';', at);
            if (semi == std::string::npos) semi = v.size();
            const std::string item = v.substr(at, semi - at);
            const size_t eq = item.find('=');
            int64_t pid = 0, ns = 0;
            ok = eq != std::string::npos && parse_int(item.substr(0, eq), &pid) && pid >= 0 && pid < 0x1FFF &&
                 parse_int(item.substr(eq + 1), &ns);
            if (ok) c.trims_ns[(int)pid] = ns;
            at = semi + 1;
        }
    }
    if (!found) *err = "unknown --config key " + key;
    else if (!ok) *err = "bad value for " + key + ": " + v;
    return found && ok;
}

const char* state_name(VirtualStc::State s) {
    switch (s) {
        case VirtualStc::State::locked: return "locked";
        case VirtualStc::State::degraded: return "degraded";
        case VirtualStc::State::lost: return "lost";
        default: return "acquiring";
    }
}

struct StatPoint {
    int64_t t;
    RestampCore::ProgramStats p;
};
struct PidRun {
    int program = -1, stream_type = -1;
    StreamClass cls = StreamClass::other;
    uint64_t in = 0, out = 0, backward = 0;
    bool have_key = false;
    int64_t last_key = 0;
    std::vector<int64_t> leads;           // house PTS - arrival of each PES kept
};
struct Run {
    int64_t t0 = 0, t_end = 0;
    size_t buffers = 0;
    std::vector<std::pair<int64_t, RestampCore::Event>> events;
    std::vector<StatPoint> stats;
    RestampCore::Stats final_stats;
    std::map<int, PidRun> pids;
    std::vector<int> programs;            // in order of their first table
    uint64_t misplaced = 0;
    size_t rerecorded = 0;
    long first_diff = -1;                 // first record the replay recorded otherwise; -1: none
    bool faithful() const { return first_diff < 0; }
};

struct ReplayOpts {
    RestampConfig cfg;
    int64_t stats_ns = 2000000000;
    bool print = true;                    // stats and events lines as they happen
    bool pes = false;                     // and a line per PES kept
    std::string trace_out;                // the trace the replay recorded
};

void print_event(int64_t t, const RestampCore::Event& e) {
    std::printf("{\"msg\":\"mrtsrestamp-event\",\"t\":%lld,\"kind\":\"%s\",\"program\":%d,\"pid\":%d,\"reason\":%s,"
                "\"gap-ns\":%lld,\"dropped-ns\":%lld,\"house-ns\":%lld,\"epoch\":%u,\"value-ns\":%lld}\n",
                (long long)t, event_kind_name(e.kind), e.program, e.pid, jstr(e.reason ? e.reason : "").c_str(),
                (long long)e.gap_ns, (long long)e.dropped_ns, (long long)e.house_ns, e.epoch, (long long)e.value_ns);
}

void print_stats(int64_t t, const RestampCore::Stats& s) {
    for (const RestampCore::ProgramStats& p : s.programs) {
        const VirtualStc::Stats& c = p.clock;
        std::printf("{\"msg\":\"mrtsrestamp-stats\",\"t\":%lld,\"program\":%d,\"state\":\"%s\",\"reason\":\"%s\","
                    "\"ppb\":%lld,\"offset-drift-ns\":%lld,\"residual-min-ns\":%lld,\"residual-p50-ns\":%lld,"
                    "\"residual-p99-ns\":%lld,\"residual-max-ns\":%lld,\"residual-count\":%u,"
                    "\"pcr-interval-max-ns\":%lld,\"cadence-warning\":%s,\"rate-warning\":%s,\"relocks\":%llu,"
                    "\"epoch\":%u,\"gaps\":%llu,\"gap-ns-total\":%lld,\"dropped-pes\":%llu,\"dropped-ns-total\":%lld,"
                    "\"cc-lost\":%llu,\"desync-bytes\":%llu}\n",
                    (long long)t, p.program, state_name(c.state), reason_name(c.reason), (long long)c.ppb,
                    (long long)c.offset_drift_ns, (long long)c.residual.min_ns, (long long)c.residual.p50_ns,
                    (long long)c.residual.p99_ns, (long long)c.residual.max_ns, c.residual.count,
                    (long long)c.pcr_interval_max_ns, c.cadence_warning ? "true" : "false",
                    c.rate_warning ? "true" : "false", (unsigned long long)c.relocks, c.epoch,
                    (unsigned long long)p.gaps, (long long)p.gap_ns_total, (unsigned long long)p.dropped_pes,
                    (long long)p.dropped_ns_total, (unsigned long long)s.cc_lost, (unsigned long long)s.desync_bytes);
    }
    for (const RestampCore::PidStats& q : s.pids)
        std::printf("{\"msg\":\"mrtsrestamp-pid\",\"t\":%lld,\"program\":%d,\"pid\":%d,\"stream-type\":%d,"
                    "\"lead-min-ns\":%lld,\"lead-median-ns\":%lld,\"lead-max-ns\":%lld,\"trim-ns\":%lld,"
                    "\"shift-ns\":%lld,\"dropped-pes\":%llu}\n",
                    (long long)t, q.program, q.pid, q.stream_type, (long long)q.lead_min_ns,
                    (long long)q.lead_median_ns, (long long)q.lead_max_ns, (long long)q.trim_ns,
                    (long long)q.shift_ns, (unsigned long long)q.dropped_pes);
}

// The trace played into a RestampCore (TracePlayer), its output read back PES by PES
// (each names its record), stats every stats_ns of trace time, and the trace the
// replay recorded compared with the one it played.
Run replay(const std::vector<TraceRecord>& recs, const ReplayOpts& o) {
    Run run;
    RestampCore core(o.cfg);
    TraceWriter again;
    again.open_memory();
    core.set_trace(&again);
    TracePlayer player(recs, RestampCore::OUTAGE_NS);
    PacketWalker walker;
    CcTracker cc;
    PesAssembler units;
    for (const TraceRecord& r : recs) {
        if (r.kind == TraceKind::pes) {
            units.select(r.pid, true);
            run.pids[r.pid].in++;
        }
        if (r.kind == TraceKind::psi) {
            const int program = (int)(r.value & 0xFFFF);
            if (std::find(run.programs.begin(), run.programs.end(), program) == run.programs.end())
                run.programs.push_back(program);
            if (!(r.value & TRACE_PSI_PCR)) {
                PidRun& p = run.pids[r.pid];
                p.program = program;
                p.stream_type = (int)((r.value >> 16) & 0xFF);
                p.cls = trace_class(r.flags);
            }
        }
    }
    const int64_t base = o.cfg.mode == RestampConfig::Mode::fixed && o.cfg.add_base_time ? o.cfg.base_time_ns : 0;
    TracePlayer::Buffer b;
    std::vector<uint8_t> out;
    std::vector<PesUnit> got;
    int64_t next_stats = 0;
    auto take = [&]() {
        for (const PesUnit& u : got) {
            uint32_t idx = 0;
            if (!trace_pes_tag(u.payload.data(), u.payload.size(), &idx) || idx >= recs.size()) continue;
            const TraceRecord& r = recs[idx];
            PidRun& p = run.pids[r.pid];
            p.out++;
            const int64_t at = sat_add(r.arrival_ns, base);
            const int64_t hp = house_from_mux_pts(u.hdr.pts, at);
            const int64_t hd = u.hdr.dts >= 0 ? house_from_mux_pts(u.hdr.dts, at) : hp;
            const int64_t key = trace_class(r.flags) == StreamClass::video ? hd : hp;
            if (p.have_key && key <= p.last_key) p.backward++;
            p.have_key = true;
            p.last_key = key;
            p.leads.push_back(hp - at);
            if (o.pes) {
                std::printf("{\"msg\":\"pes\",\"t\":%lld,\"rec\":%u,\"pid\":%u,\"pts\":%llu,\"dtsMinusPts\":%d,"
                            "\"outPts\":%lld,\"outDts\":%lld,\"housePtsNs\":%lld,\"houseDtsNs\":%lld,"
                            "\"leadNs\":%lld}\n",
                            (long long)r.arrival_ns, idx, (unsigned)r.pid, (unsigned long long)r.value,
                            r.dts_minus_pts_90k, (long long)u.hdr.pts, (long long)u.hdr.dts, (long long)hp,
                            (long long)hd, (long long)(hp - at));
            }
        }
        got.clear();
    };
    while (player.next(&b)) {
        if (run.buffers++ == 0) {
            run.t0 = run.t_end = b.arrival_ns;
            next_stats = sat_add(run.t0, o.stats_ns);
        }
        // Stats on the trace's clock, before the buffer that passes each interval; the
        // tick lets a clock in an outage show lost, as the element's task does. A
        // garbage arrival far ahead gets one line, not millions on the way.
        const uint64_t ahead = (uint64_t)b.arrival_ns - (uint64_t)next_stats;
        if (b.arrival_ns > next_stats && ahead > 100000 * (uint64_t)o.stats_ns)
            next_stats = b.arrival_ns - (int64_t)(ahead % (uint64_t)o.stats_ns);
        while (b.arrival_ns >= next_stats) {
            core.tick(next_stats);
            const RestampCore::Stats s = core.stats();
            for (const RestampCore::ProgramStats& p : s.programs) run.stats.push_back(StatPoint{next_stats, p});
            if (o.print) print_stats(next_stats, s);
            if (next_stats > INT64_MAX - o.stats_ns) break;
            next_stats += o.stats_ns;
        }
        const RestampCore::Result res = core.process(b.bytes.data(), b.bytes.size(), b.arrival_ns);
        for (const RestampCore::Event& e : core.take_events()) {
            run.events.push_back({b.arrival_ns, e});
            if (o.print) print_event(b.arrival_ns, e);
        }
        out.clear();
        for (const RestampCore::Range& k : res.keep) out.insert(out.end(), k.data, k.data + k.len);
        walker.feed(out.data(), out.size(), [&](PacketView& v) { units.feed(v, cc.feed(v), got); });
        take();
        run.t_end = std::max(run.t_end, b.arrival_ns);
    }
    units.flush(got);
    take();
    run.final_stats = core.stats();
    core.set_trace(nullptr);
    run.misplaced = player.misplaced();
    const std::vector<TraceRecord>& rec2 = again.records();
    run.rerecorded = rec2.size();
    for (size_t i = 0; i < std::max(recs.size(), rec2.size()) && run.first_diff < 0; i++)
        if (i >= recs.size() || i >= rec2.size() || !(recs[i] == rec2[i])) run.first_diff = (long)i;
    if (!o.trace_out.empty()) {
        TraceWriter w;
        bool ok = w.open(o.trace_out);
        for (const TraceRecord& r : rec2) w.write(r);
        if (!w.close() || !ok) std::fprintf(stderr, "mrts_cli: writing %s failed\n", o.trace_out.c_str());
    }
    return run;
}

// What one program did over the replay, the facts an expectation file names.
struct ProgramSum {
    int program = 0;
    int relocks = 0, degraded = 0, recovered = 0, steps = 0, gaps = 0, overlaps = 0, psi = 0, clamps = 0;
    std::vector<std::string> reasons;     // relock reasons, in order
    uint32_t epoch = 0;
    int64_t gap_ns = 0, gap_min = 0, gap_max = 0, overlap_ns = 0;
    std::map<int, int> gaps_by_pid;
    uint64_t dropped_pes = 0;
    int64_t dropped_ns = 0;
    int64_t locked_at = -1;               // first stats line locked, ns from the start
    std::string final_state;
    int64_t final_ppb = 0;
    int64_t ppb_min = 0, ppb_max = 0;     // over the stats lines while locked
    int64_t residual_min = 0;             // lowest residual-min of a locked line
    bool any_locked = false, cadence_warning = false;
    // The offset drift's speed over MAPPING_WINDOW_NS while locked on one epoch. It moves
    // at bucket closes, so the window reads up to one bucket's travel high (1/30).
    int64_t mapping_ppb_max = 0;
    uint64_t pes_in = 0, pes_out = 0, backward = 0;
    int64_t lead_max = INT64_MIN;         // the highest house PTS - arrival of a PES kept
    // ε on the last stats line at each convergence mark the trace reaches (the sweep's
    // drift criterion, part 4.3).
    int64_t ppb_at[4] = {0, 0, 0, 0};
    bool has_at[4] = {false, false, false, false};
};

constexpr int64_t MAPPING_WINDOW_NS = 30000000000LL;
constexpr int64_t PPB_MARKS_S[4] = {60, 120, 300, 600};   // WI-P1-1's convergence marks

ProgramSum summarize(const Run& run, int program) {
    ProgramSum s;
    s.program = program;
    for (const auto& te : run.events) {
        const RestampCore::Event& e = te.second;
        if (e.program != program) continue;
        switch (e.kind) {
            case RestampCore::Event::Kind::relock:
                s.relocks++;
                s.reasons.push_back(e.reason ? e.reason : "");
                break;
            case RestampCore::Event::Kind::degraded: s.degraded++; break;
            case RestampCore::Event::Kind::recovered: s.recovered++; break;
            case RestampCore::Event::Kind::envelope_step: s.steps++; break;
            case RestampCore::Event::Kind::gap:
                s.gap_min = s.gaps ? std::min(s.gap_min, e.gap_ns) : e.gap_ns;
                s.gap_max = s.gaps ? std::max(s.gap_max, e.gap_ns) : e.gap_ns;
                s.gaps++;
                s.gap_ns += e.gap_ns;
                s.gaps_by_pid[e.pid]++;
                break;
            case RestampCore::Event::Kind::overlap:
                s.overlaps++;
                s.overlap_ns += e.dropped_ns;
                break;
            case RestampCore::Event::Kind::lead_clamp: s.clamps++; break;
            default: s.psi++; break;
        }
    }
    for (const RestampCore::ProgramStats& p : run.final_stats.programs) {
        if (p.program != program) continue;
        s.epoch = p.clock.epoch;
        s.final_state = state_name(p.clock.state);
        s.final_ppb = p.clock.ppb;
        s.dropped_pes = p.dropped_pes;
        s.dropped_ns = p.dropped_ns_total;
    }
    std::vector<const StatPoint*> mine;
    for (const StatPoint& sp : run.stats)
        if (sp.p.program == program) mine.push_back(&sp);
    size_t from = 0;                      // the window's start: locked, same epoch, unbroken
    for (size_t i = 0; i < mine.size(); i++) {
        const VirtualStc::Stats& c = mine[i]->p.clock;
        s.cadence_warning |= c.cadence_warning;
        for (int k = 0; k < 4; k++)
            if (sat_sub(mine[i]->t, run.t0) <= PPB_MARKS_S[k] * 1000000000LL &&
                sat_sub(run.t_end, run.t0) >= PPB_MARKS_S[k] * 1000000000LL) {
                s.ppb_at[k] = c.ppb;
                s.has_at[k] = true;
            }
        if (c.state != VirtualStc::State::locked) {
            from = i + 1;
            continue;
        }
        if (s.locked_at < 0) s.locked_at = sat_sub(mine[i]->t, run.t0);
        s.ppb_min = s.any_locked ? std::min(s.ppb_min, c.ppb) : c.ppb;
        s.ppb_max = s.any_locked ? std::max(s.ppb_max, c.ppb) : c.ppb;
        if (c.residual.count)
            s.residual_min = s.any_locked ? std::min(s.residual_min, c.residual.min_ns) : c.residual.min_ns;
        s.any_locked = true;
        if (from < i && mine[from]->p.clock.epoch != c.epoch) from = i;
        while (from < i && sat_sub(mine[i]->t, mine[from + 1]->t) >= MAPPING_WINDOW_NS) from++;
        const int64_t dt = sat_sub(mine[i]->t, mine[from]->t);
        if (dt >= MAPPING_WINDOW_NS) {
            const int64_t d = sat_sub(c.offset_drift_ns, mine[from]->p.clock.offset_drift_ns);
            const int64_t ad = std::min<int64_t>(d < 0 ? sat_sub(0, d) : d, 1000000000000000LL);   // 11 days
            s.mapping_ppb_max = std::max(s.mapping_ppb_max, ad * 1000 / (dt / 1000000));
        }
    }
    for (const auto& kv : run.pids) {
        if (kv.second.program != program) continue;
        s.pes_in += kv.second.in;
        s.pes_out += kv.second.out;
        s.backward += kv.second.backward;
        for (const int64_t l : kv.second.leads) s.lead_max = std::max(s.lead_max, l);
    }
    return s;
}

// One program's facts as JSON: the summary's program objects and each sweep line's.
void print_program(const ProgramSum& s) {
    std::printf("{\"program\":%d,\"relocks\":%d,\"relockReasons\":[", s.program, s.relocks);
    for (size_t k = 0; k < s.reasons.size(); k++) std::printf("%s%s", k ? "," : "", jstr(s.reasons[k]).c_str());
    std::printf("],\"epochs\":%u,\"degraded\":%d,\"recovered\":%d,\"envelopeSteps\":%d,\"leadClamps\":%d,\"gaps\":%d,"
                "\"gapNsTotal\":%lld,\"gapNsMin\":%lld,\"gapNsMax\":%lld,\"overlaps\":%d,\"overlapNs\":%lld,"
                "\"droppedPes\":%llu,\"droppedNsTotal\":%lld,\"lockedAtNs\":%lld,\"finalState\":\"%s\","
                "\"finalPpb\":%lld,\"lockedPpbMin\":%lld,\"lockedPpbMax\":%lld,\"residualMinNs\":%lld,"
                "\"cadenceWarning\":%s,\"mappingPpbMax\":%lld,\"pesIn\":%llu,\"pesOut\":%llu,\"backward\":%llu,"
                "\"leadMaxNs\":%lld,"
                "\"ppbAtS\":{",
                s.epoch, s.degraded, s.recovered, s.steps, s.clamps, s.gaps, (long long)s.gap_ns, (long long)s.gap_min,
                (long long)s.gap_max, s.overlaps, (long long)s.overlap_ns, (unsigned long long)s.dropped_pes,
                (long long)s.dropped_ns, (long long)s.locked_at, s.final_state.c_str(), (long long)s.final_ppb,
                (long long)s.ppb_min, (long long)s.ppb_max, (long long)s.residual_min,
                s.cadence_warning ? "true" : "false", (long long)s.mapping_ppb_max, (unsigned long long)s.pes_in,
                (unsigned long long)s.pes_out, (unsigned long long)s.backward,
                (long long)(s.lead_max == INT64_MIN ? 0 : s.lead_max));
    for (int k = 0, n = 0; k < 4; k++)
        if (s.has_at[k]) std::printf("%s\"%lld\":%lld", n++ ? "," : "", (long long)PPB_MARKS_S[k], (long long)s.ppb_at[k]);
    std::printf("}}");
}

void print_summary(const Run& run) {
    std::printf("{\"msg\":\"summary\",\"durationNs\":%lld,\"buffers\":%zu,\"faithful\":%s,\"rerecorded\":%zu",
                (long long)sat_sub(run.t_end, run.t0), run.buffers, run.faithful() ? "true" : "false", run.rerecorded);
    if (!run.faithful()) std::printf(",\"firstDiff\":%ld", run.first_diff);
    std::printf(",\"misplaced\":%llu,\"programs\":[", (unsigned long long)run.misplaced);
    for (size_t i = 0; i < run.programs.size(); i++) {
        if (i) std::printf(",");
        print_program(summarize(run, run.programs[i]));
    }
    std::printf("],\"pids\":[");
    bool first = true;
    for (const auto& kv : run.pids) {
        const PidRun& p = kv.second;
        std::vector<int64_t> v = p.leads;
        std::sort(v.begin(), v.end());
        std::printf("%s{\"pid\":%d,\"program\":%d,\"class\":\"%s\",\"pesIn\":%llu,\"pesOut\":%llu,\"backward\":%llu",
                    first ? "" : ",", kv.first, p.program, class_name(p.cls) ? class_name(p.cls) : "other",
                    (unsigned long long)p.in, (unsigned long long)p.out, (unsigned long long)p.backward);
        if (!v.empty())
            std::printf(",\"leadMinNs\":%lld,\"leadMedianNs\":%lld,\"leadMaxNs\":%lld", (long long)v.front(),
                        (long long)v[(v.size() - 1) / 2], (long long)v.back());
        std::printf("}");
        first = false;
    }
    std::printf("]}\n");
}

// --- Expectation files (.expect.json): what a replay must show ---------------------------

// N, or [lo, hi] inclusive.
bool range_ok(const Json& j, double v, std::string* want) {
    double lo, hi;
    if (j.type == Json::Type::array && j.items.size() == 2 && j.items[0].f64(&lo) && j.items[1].f64(&hi)) {
        *want = "[" + j.items[0].s + ", " + j.items[1].s + "]";
        return v >= lo && v <= hi;
    }
    if (j.f64(&lo)) {
        *want = j.s;
        return v == lo;
    }
    *want = "a number or [lo, hi]";
    return false;
}

std::string num(double v) {
    char b[48];
    std::snprintf(b, sizeof b, "%.6g", v);
    return b;
}

// Failures, one string each; an empty list passes. Times are seconds from the trace's
// first arrival, lengths ms, rates ppm.
std::vector<std::string> check_expect(const Json& x, const Run& run) {
    std::vector<std::string> fail;
    if (x.type != Json::Type::object) return {"the expectation is not a JSON object"};
    int64_t program = run.programs.empty() ? 1 : run.programs.front();
    if (const Json* p = x.get("program"))
        if (!p->i64(&program)) fail.push_back("\"program\" is not an integer");
    if (std::find(run.programs.begin(), run.programs.end(), (int)program) == run.programs.end())
        fail.push_back("program " + std::to_string(program) + " is not in the trace");
    const ProgramSum s = summarize(run, (int)program);
    auto count = [&](const char* key, double v) {
        const Json* j = x.get(key);
        std::string want;
        if (j && !range_ok(*j, v, &want)) fail.push_back(std::string(key) + ": " + num(v) + ", want " + want);
    };
    auto flag = [&](const char* key, bool v) {
        const Json* j = x.get(key);
        if (j && (j->type != Json::Type::boolean || j->b != v))
            fail.push_back(std::string(key) + ": " + (v ? "true" : "false"));
    };
    std::vector<std::string> known = {"source", "note", "program", "relockReasons", "events", "ppmAfterS",
                                      "lockedWithinS", "residualMinMs", "finalState", "mappingPpmMax", "gapMs",
                                      "gapsPerPid", "ppm", "leadMaxMs"};
    const char* counts[] = {"relocks", "epochs", "degraded", "recovered", "envelopeSteps", "gaps", "overlaps",
                            "droppedPes", "droppedMs", "psiChanges", "leadClamps"};
    const double vals[] = {(double)s.relocks, (double)s.epoch, (double)s.degraded, (double)s.recovered,
                           (double)s.steps, (double)s.gaps, (double)s.overlaps, (double)s.dropped_pes,
                           s.dropped_ns / 1e6, (double)s.psi, (double)s.clamps};
    for (size_t i = 0; i < sizeof counts / sizeof counts[0]; i++) {
        count(counts[i], vals[i]);
        known.push_back(counts[i]);
    }
    const char* flags[] = {"cadenceWarning", "monotonic", "faithful"};
    const bool fvals[] = {s.cadence_warning, s.backward == 0, run.faithful()};
    for (size_t i = 0; i < 3; i++) {
        flag(flags[i], fvals[i]);
        known.push_back(flags[i]);
    }
    if (const Json* j = x.get("relockReasons")) {
        std::vector<std::string> want;
        for (const Json& r : j->items) want.push_back(r.s);
        if (j->type != Json::Type::array || want != s.reasons) {
            std::string got;
            for (const std::string& r : s.reasons) got += (got.empty() ? "" : ",") + r;
            fail.push_back("relockReasons: [" + got + "]");
        }
    }
    if (const Json* j = x.get("finalState"))
        if (j->s != s.final_state) fail.push_back("finalState: " + s.final_state + ", want " + j->s);
    double lim = 0;
    if (const Json* j = x.get("lockedWithinS")) {
        if (!j->f64(&lim) || s.locked_at < 0 || s.locked_at / 1e9 > lim)
            fail.push_back("lockedWithinS: " +
                           (s.locked_at < 0 ? std::string("never locked") : num(s.locked_at / 1e9)));
    }
    if (const Json* j = x.get("residualMinMs")) {
        if (!j->f64(&lim) || !s.any_locked || s.residual_min / 1e6 < lim)
            fail.push_back("residualMinMs: " + num(s.residual_min / 1e6));
    }
    if (const Json* j = x.get("mappingPpmMax")) {
        if (!j->f64(&lim) || s.mapping_ppb_max / 1e3 > lim)
            fail.push_back("mappingPpmMax: " + num(s.mapping_ppb_max / 1e3));
    }
    if (const Json* j = x.get("leadMaxMs")) {   // no PES kept further ahead of its arrival
        if (!j->f64(&lim) || s.lead_max == INT64_MIN || s.lead_max / 1e6 > lim)
            fail.push_back("leadMaxMs: " + (s.lead_max == INT64_MIN ? std::string("no PES") : num(s.lead_max / 1e6)));
    }
    if (const Json* j = x.get("ppm")) {
        // Every stats line of the program from ppmAfterS on.
        double after = 0;
        if (const Json* a = x.get("ppmAfterS")) a->f64(&after);
        int n = 0;
        std::string want;
        for (const StatPoint& sp : run.stats) {
            if (sp.p.program != (int)program || sat_sub(sp.t, run.t0) / 1e9 < after) continue;
            n++;
            if (!range_ok(*j, sp.p.clock.ppb / 1e3, &want)) {
                fail.push_back("ppm: " + num(sp.p.clock.ppb / 1e3) + " at " + num(sat_sub(sp.t, run.t0) / 1e9) +
                               " s, want " + want);
                break;
            }
        }
        if (!n) fail.push_back("ppm: no stats line after " + num(after) + " s");
    }
    if (const Json* j = x.get("gapMs")) {
        std::string want;
        for (const auto& te : run.events)
            if (te.second.program == (int)program && te.second.kind == RestampCore::Event::Kind::gap &&
                !range_ok(*j, te.second.gap_ns / 1e6, &want)) {
                fail.push_back("gapMs: " + num(te.second.gap_ns / 1e6) + " on PID " + std::to_string(te.second.pid) +
                               ", want " + want);
                break;
            }
    }
    if (const Json* j = x.get("gapsPerPid")) {
        std::string want;
        for (const auto& kv : run.pids) {
            if (kv.second.program != (int)program || !kv.second.in) continue;
            const auto it = s.gaps_by_pid.find(kv.first);
            const int n = it == s.gaps_by_pid.end() ? 0 : it->second;
            if (!range_ok(*j, n, &want))
                fail.push_back("gapsPerPid: " + std::to_string(n) + " on PID " + std::to_string(kv.first) +
                               ", want " + want);
        }
    }
    if (const Json* j = x.get("events")) {
        // An ordered subsequence: each wanted event matches a later one than the last.
        size_t at = 0;
        for (const Json& w : j->items) {
            const Json* kind = w.get("kind");
            const Json* reason = w.get("reason");
            const Json* pid = w.get("pid");
            const Json* when = w.get("atS");
            const Json* gap = w.get("gapMs");
            const Json* drop = w.get("droppedMs");
            for (const auto& kv : w.keys)
                if (kv.first != "kind" && kv.first != "reason" && kv.first != "pid" && kv.first != "atS" &&
                    kv.first != "gapMs" && kv.first != "droppedMs")
                    fail.push_back("events: unknown key \"" + kv.first + "\"");
            bool found = false;
            std::string want;
            int64_t pv = 0;
            for (; at < run.events.size() && !found; at++) {
                const RestampCore::Event& e = run.events[at].second;
                found = e.program == (int)program && (!kind || kind->s == event_kind_name(e.kind)) &&
                        (!reason || reason->s == (e.reason ? e.reason : "")) &&
                        (!pid || (pid->i64(&pv) && pv == e.pid)) &&
                        (!when || range_ok(*when, sat_sub(run.events[at].first, run.t0) / 1e9, &want)) &&
                        (!gap || range_ok(*gap, e.gap_ns / 1e6, &want)) &&
                        (!drop || range_ok(*drop, e.dropped_ns / 1e6, &want));
            }
            if (!found) {
                std::string d;
                for (const auto& kv : w.keys)
                    d += (d.empty() ? "" : " ") + kv.first + "=" + (kv.second.s.empty() ? "[..]" : kv.second.s);
                fail.push_back("events: no " + d + " in order");
                break;
            }
        }
    }
    for (const auto& kv : x.keys)
        if (std::find(known.begin(), known.end(), kv.first) == known.end())
            fail.push_back("unknown expectation key \"" + kv.first + "\"");
    return fail;
}

void print_expect(const std::vector<std::string>& fail) {
    std::printf("{\"msg\":\"expect\",\"ok\":%s,\"failures\":[", fail.empty() ? "true" : "false");
    for (size_t i = 0; i < fail.size(); i++) std::printf("%s%s", i ? "," : "", jstr(fail[i]).c_str());
    std::printf("]}\n");
}

const char kReplayUsage[] =
    "usage: mrts_cli restamp-replay input.stct [--config k=v...] [--sweep grid.json] [--expect file]\n"
    "                               [--stats-interval-ms N] [--pes] [--quiet] [--trace-out out.stct]\n"
    "  Plays the trace into RestampCore and prints JSON lines: mrtsrestamp-stats / -pid / -event\n"
    "  as the element posts them (\"t\": the trace's house ns), then a summary; --expect checks\n"
    "  the replay against an expectation file (exit 1 on a failure). --config sets RestampConfig\n"
    "  (mode, add_base_time, base_time_ns, offset_ns, pid_trims=<pid>=<ns>;...) and every\n"
    "  ClockLockConfig / PcrValidatorConfig field by name (clock. / pcr. to pick one). --sweep\n"
    "  replays once per point of {\"key\": [values], ...} and prints one line per point: its\n"
    "  config, the expectation's verdict and the first program's summary (ppbAtS: epsilon at\n"
    "  60/120/300/600 s).\n";

int restamp_replay_main(int argc, char** argv) {
    ReplayOpts o;
    std::string input, sweep_path, expect_path;
    bool quiet = false;
    std::vector<std::pair<std::string, std::string>> config;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--config") {
            // One or more k=v after it, up to the next option.
            int n = 0;
            while (i + 1 < argc && argv[i + 1][0] != '-' && std::strchr(argv[i + 1], '=')) {
                const std::string kv = argv[++i];
                config.push_back({kv.substr(0, kv.find('=')), kv.substr(kv.find('=') + 1)});
                n++;
            }
            if (!n) return std::fputs(kReplayUsage, stderr), 2;
        } else if (a == "--sweep" && i + 1 < argc) {
            sweep_path = argv[++i];
        } else if (a == "--expect" && i + 1 < argc) {
            expect_path = argv[++i];
        } else if (a == "--stats-interval-ms" && i + 1 < argc) {
            int64_t ms = 0;
            if (!parse_int(argv[++i], &ms) || ms <= 0 || ms > 3600000) return std::fputs(kReplayUsage, stderr), 2;
            o.stats_ns = ms * 1000000;
        } else if (a == "--pes") {
            o.pes = true;
        } else if (a == "--quiet") {
            quiet = true;
        } else if (a == "--trace-out" && i + 1 < argc) {
            o.trace_out = argv[++i];
        } else if (a[0] != '-' && input.empty()) {
            input = a;
        } else {
            return std::fputs(kReplayUsage, stderr), 2;
        }
    }
    if (input.empty()) return std::fputs(kReplayUsage, stderr), 2;
    for (const auto& kv : config) {
        std::string err;
        if (!set_knob(o.cfg, kv.first, kv.second, &err)) {
            std::fprintf(stderr, "mrts_cli: %s\n", err.c_str());
            return 2;
        }
    }
    std::vector<TraceRecord> recs;
    TraceReader::Status st;
    if (!read_trace(input, &recs, &st)) return 1;
    Json expect, grid;
    for (const auto& f : {std::make_pair(&expect_path, &expect), std::make_pair(&sweep_path, &grid)}) {
        if (f.first->empty()) continue;
        std::string text, err;
        if (!read_file(*f.first, &text) || !parse_json(text, f.second, &err)) {
            std::fprintf(stderr, "mrts_cli: %s: %s\n", f.first->c_str(), err.empty() ? "cannot read" : err.c_str());
            return 1;
        }
    }
    const Json* x = expect_path.empty() ? nullptr : &expect;
    if (sweep_path.empty()) {
        o.print = !quiet;
        o.pes = o.pes && !quiet;
        const Run run = replay(recs, o);
        print_summary(run);
        if (!x) return 0;
        const std::vector<std::string> fail = check_expect(*x, run);
        print_expect(fail);
        return fail.empty() ? 0 : 1;
    }
    // The sweep: the odometer over every axis, the last fastest.
    if (grid.type != Json::Type::object || grid.keys.empty()) {
        std::fprintf(stderr, "mrts_cli: %s: want {\"key\": [values], ...}\n", sweep_path.c_str());
        return 1;
    }
    struct Axis {
        std::string key;
        std::vector<std::string> vals, shown;   // as --config takes it; as JSON
    };
    std::vector<Axis> axes;
    size_t points = 1;
    for (const auto& kv : grid.keys) {
        std::vector<std::string> vals, shown;
        for (const Json& v : kv.second.items) {
            vals.push_back(v.type == Json::Type::boolean ? (v.b ? "true" : "false") : v.s);
            shown.push_back(v.type == Json::Type::string ? jstr(v.s) : vals.back());
        }
        RestampConfig probe = o.cfg;
        std::string err;
        for (const std::string& v : vals)
            if (err.empty() && !set_knob(probe, kv.first, v, &err)) break;
        if (kv.second.type != Json::Type::array || vals.empty() || !err.empty()) {
            std::fprintf(stderr, "mrts_cli: %s: axis %s: %s\n", sweep_path.c_str(), kv.first.c_str(),
                         err.empty() ? "want a non-empty array" : err.c_str());
            return 1;
        }
        points *= vals.size();
        if (points > 100000) {
            std::fprintf(stderr, "mrts_cli: %s: more than 100000 points\n", sweep_path.c_str());
            return 1;
        }
        axes.push_back(Axis{kv.first, vals, shown});
    }
    std::vector<size_t> idx(axes.size(), 0);
    size_t passed = 0;
    o.print = o.pes = false;
    for (size_t n = 0; n < points; n++) {
        ReplayOpts p = o;
        std::string err, cfg;
        for (size_t a = 0; a < axes.size(); a++) {
            set_knob(p.cfg, axes[a].key, axes[a].vals[idx[a]], &err);
            cfg += (a ? "," : "") + jstr(axes[a].key) + ":" + axes[a].shown[idx[a]];
        }
        const Run run = replay(recs, p);
        const std::vector<std::string> fail = x ? check_expect(*x, run) : std::vector<std::string>();
        passed += fail.empty();
        std::printf("{\"msg\":\"sweep\",\"point\":%zu,\"config\":{%s},\"ok\":%s,\"failures\":[", n, cfg.c_str(),
                    fail.empty() ? "true" : "false");
        for (size_t i = 0; i < fail.size(); i++) std::printf("%s%s", i ? "," : "", jstr(fail[i]).c_str());
        std::printf("],\"summary\":");
        print_program(summarize(run, run.programs.empty() ? 1 : run.programs.front()));
        std::printf("}\n");
        for (size_t a = axes.size(); a-- > 0;) {
            if (++idx[a] < axes[a].vals.size()) break;
            idx[a] = 0;
        }
    }
    std::printf("{\"msg\":\"sweep-done\",\"points\":%zu,\"passed\":%zu}\n", points, passed);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::strcmp(argv[1], "dump") == 0) return dump_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "trace2jsonl") == 0) return trace2jsonl_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "jsonl2trace") == 0) return jsonl2trace_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "restamp-replay") == 0) return restamp_replay_main(argc - 1, argv + 1);
    std::vector<SplitterCore::OutputSpec> outputs;
    long chunk = 1316;
    int ts_id = 1;
    std::string out_dir, input;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--chunk" && i + 1 < argc) {
            chunk = std::atol(argv[++i]);
        } else if (a == "--ts-id" && i + 1 < argc) {
            ts_id = std::atoi(argv[++i]);
        } else if (a == "--out-dir" && i + 1 < argc) {
            out_dir = argv[++i];
        } else if (a == "--outputs" && i + 1 < argc) {
            char* spec = argv[++i];
            for (char* tok = std::strtok(spec, ","); tok; tok = std::strtok(nullptr, ",")) {
                SplitterCore::OutputSpec o;
                char* colon = std::strchr(tok, ':');
                if (colon) {
                    *colon = 0;
                    o.stream_type = (int)std::strtol(colon + 1, nullptr, 0);
                }
                o.pid = (int)std::strtol(tok, nullptr, 0);
                outputs.push_back(o);
            }
        } else if (a[0] != '-') {
            input = a;
        } else {
            std::fprintf(stderr, "unknown arg: %s\n", a.c_str());
            return 2;
        }
    }
    if (outputs.empty() || out_dir.empty() || input.empty() || chunk <= 0) {
        std::fprintf(stderr,
                     "usage: mrts_cli --outputs 0x100[:0x1b],... [--chunk N] "
                     "[--ts-id N] --out-dir DIR input.ts\n"
                     "       mrts_cli dump [--chunk N] [--program N] input.ts\n"
                     "       mrts_cli trace2jsonl input.stct\n"
                     "       mrts_cli jsonl2trace input.jsonl|- output.stct\n"
                     "       mrts_cli restamp-replay input.stct [--config k=v...] [--sweep grid.json] "
                     "[--expect file] ...\n");
        return 2;
    }

    FILE* f = std::fopen(input.c_str(), "rb");
    if (!f) {
        std::perror("open input");
        return 1;
    }
    std::fseek(f, 0, SEEK_END);
    long sz = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> data((size_t)sz);
    if (sz && std::fread(data.data(), 1, (size_t)sz, f) != (size_t)sz) {
        std::perror("read input");
        return 1;
    }
    std::fclose(f);

    std::vector<std::pair<int, FILE*>> files;
    for (const auto& o : outputs) {
        char path[4096];
        std::snprintf(path, sizeof path, "%s/out_0x%x.ts", out_dir.c_str(), o.pid);
        FILE* of = std::fopen(path, "wb");
        if (!of) {
            std::perror("open output");
            return 1;
        }
        files.push_back({o.pid, of});
    }

    SplitterCallbacks cb;
    cb.on_discovered = emit_discovered;
    cb.on_videoinfo = emit_videoinfo;
    cb.on_desync = [](long long dropped) {
        std::printf("{\"event\":\"desync\",\"dropped\":%lld}\n", dropped);
    };
    SplitterCore core(ts_id, outputs, cb);

    for (long off = 0; off < sz; off += chunk) {
        long n = std::min(chunk, sz - off);
        for (const auto& b : core.feed(data.data() + off, (size_t)n))
            for (auto& [pid, of] : files)
                if (pid == b.pid)
                    std::fwrite(b.data->data(), 1, b.data->size(), of);
    }
    for (auto& [pid, of] : files) std::fclose(of);
    std::printf("{\"event\":\"done\",\"desyncBytes\":%lld}\n", core.desync_bytes());
    return 0;
}
