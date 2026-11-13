// mrts_cli: test harness for the mrts core. `dump` prints every PES of the followed program,
// PSI events and counters as JSON lines.
// Usage: mrts_cli dump [--chunk 1316] [--program N] [--net E_ns] input.ts
//        mrts_cli trace2jsonl input.stct
//        mrts_cli jsonl2trace input.jsonl|- output.stct
//        mrts_cli restamp-replay input.stct [--config k=v...] [--sweep grid.json] [--expect file]
//        mrts_cli rebase in.ts out.ts --to-ns T [--bus in.bus.jsonl out.bus.jsonl]
//        mrts_cli demux in.ts [--chunk N] [--media M] [--select CAPS] [--program P] [--house-ns T]
//                           [--bus in.bus.jsonl]
//        mrts_cli asrc seq.txt|-
//        mrts_cli pace seq.jsonl|-
//        mrts_cli asrc-device seq.jsonl|-
//        mrts_cli drain seq.jsonl|-
//        mrts_cli egress in.ts --clock case.clock.json [--bus B] [--chunk N] [--out O] [--expect E]
//        mrts_cli pcrcheck in.ts [--arrival in.stct]
//        mrts_cli hcdesc in.ts
//        mrts_cli trust-replay events.jsonl|- [--pes]
#include <algorithm>
#include <array>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "asrc_servo.h"
#include "demux_core.h"
#include "drain_servo.h"
#include "ts_egress.h"
#include "ts_dump.h"
#include "ts_gap.h"
#include "ts_hcdesc.h"
#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"
#include "ts_rebase.h"
#include "ts_restamp.h"
#include "ts_stc.h"
#include "ts_trace.h"
#include "ts_trust.h"
#include "video_pace.h"

using namespace mrts;

namespace {

bool parse_int(const std::string& s, int64_t* v);

int dump_main(int argc, char** argv) {
    long chunk = 1316;
    int program = -1;
    std::string input;
    bool net = false;
    NetEpoch e;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--chunk" && i + 1 < argc) {
            chunk = std::atol(argv[++i]);
        } else if (a == "--program" && i + 1 < argc) {
            program = std::atoi(argv[++i]);
        } else if (a == "--net" && i + 1 < argc && parse_int(argv[i + 1], &e.e_ns)) {
            net = true;
            i++;
        } else if (a[0] != '-' && input.empty()) {
            input = a;
        } else {
            input.clear();
            break;
        }
    }
    if (input.empty() || chunk <= 0) {
        std::fprintf(stderr, "usage: mrts_cli dump [--chunk N] [--program N] [--net E_ns] input.ts\n"
                             "  --net: a wire capture; each PES also gives ptsBus and dtsBus, net_to_bus at E\n");
        return 2;
    }
    FILE* f = std::fopen(input.c_str(), "rb");
    if (!f) {
        std::perror("open input");
        return 1;
    }
    std::vector<uint8_t> buf((size_t)chunk);
    PesIndex dump([](const std::string& line) { std::printf("%s\n", line.c_str()); }, program);
    if (net) dump.set_net(e);
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
        case TraceKind::decl: return "decl";
        case TraceKind::decl2: return "decl2";
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

// decl and decl2 (p5-6t): one line per pair, the declaration's fields by name; a decl2
// with no decl before it at its arrival a line of its own. Lossless, as record_json.
constexpr uint8_t DECL_FLAGS_REST = 0x0E;
const char* const kDecl2Keys[] = {"hcVersion", "syncSource", "taiUtcOffsetS", "ptpDomain",
                                  "gmIdentity", "clockErrorClass", "epochSeq"};

std::string decl2_json(const TraceRecord& b) {
    const uint32_t x = (uint32_t)b.dts_minus_pts_90k;
    char o[200];
    std::snprintf(o, sizeof o,
                  ",\"hcVersion\":%u,\"syncSource\":%u,\"taiUtcOffsetS\":%u,\"ptpDomain\":%u,\"gmIdentity\":\"%s\","
                  "\"clockErrorClass\":%u,\"epochSeq\":%u",
                  (x >> 16) & 0xFF, x & 0xFF, x >> 24, (x >> 8) & 0xFF, hcdesc::gm_text(b.value).c_str(),
                  (unsigned)b.flags, (unsigned)b.pid);
    return o;
}

std::string decl_json(const TraceRecord& a, const TraceRecord* b) {
    char o[320];
    const bool present = a.flags & TRACE_DECL_PRESENT;
    std::snprintf(o, sizeof o, "{\"t\":%lld,\"kind\":\"decl\",\"program\":%u,\"present\":%s", (long long)a.arrival_ns,
                  (unsigned)a.pid, present ? "true" : "false");
    std::string s = o;
    // An absent one as a recorder writes it shows nothing more.
    if (present || a.value || a.dts_minus_pts_90k || (a.flags & TRACE_DECL_FLAGS)) {
        auto tf = [&](uint8_t bit) { return (a.flags & bit) ? "true" : "false"; };
        std::snprintf(o, sizeof o,
                      ",\"houseTimeTai\":%s,\"disciplined\":%s,\"traceable\":%s,\"ptpValid\":%s,\"timelineId\":\"%s\","
                      "\"de90k\":%u",
                      tf(0x80), tf(0x40), tf(0x20), tf(0x10), hcdesc::timeline_text(a.value).c_str(),
                      (unsigned)(uint32_t)a.dts_minus_pts_90k);
        s += o;
    }
    if (a.flags & DECL_FLAGS_REST) s += ",\"flagsRest\":" + std::to_string((unsigned)(a.flags & DECL_FLAGS_REST));
    if (b) s += decl2_json(*b);
    return s + "}";
}

std::string decl2_alone_json(const TraceRecord& b) {
    return "{\"t\":" + std::to_string((long long)b.arrival_ns) + ",\"kind\":\"decl2\"" + decl2_json(b) + "}";
}

// A decl line's records: the decl, then its decl2 when the line names its fields (all or none).
bool decl_from_json(const Json& j, bool decl, std::vector<TraceRecord>* out, std::string* err) {
    std::vector<std::string> allowed = {"t", "kind"};
    uint64_t u = 0;
    int64_t t = 0;
    const Json* x = j.get("t");
    if (!x || !x->i64(&t)) return *err = "missing or bad \"t\"", false;
    auto need_u = [&](const char* key, uint64_t max, uint64_t* v) {
        const Json* y = j.get(key);
        if (!y || !y->u64(v) || *v > max) return *err = std::string("missing or bad \"") + key + "\"", false;
        return true;
    };
    auto boolean = [&](const char* key, bool* v) {
        const Json* y = j.get(key);
        if (!y || y->type != Json::Type::boolean) return *err = std::string("missing or bad \"") + key + "\"", false;
        *v = y->b;
        return true;
    };
    TraceRecord a;
    a.arrival_ns = t;
    a.kind = TraceKind::decl;
    if (decl) {
        for (const char* k : {"program", "present", "houseTimeTai", "disciplined", "traceable", "ptpValid",
                              "timelineId", "de90k", "flagsRest"})
            allowed.push_back(k);
        bool present = false;
        if (!need_u("program", 0xFFFF, &u) || !boolean("present", &present)) return false;
        a.pid = (uint16_t)u;
        a.flags = present ? TRACE_DECL_PRESENT : 0;
        // The declaration's own fields: required when present, else 0 unless given.
        const char* bits[] = {"houseTimeTai", "disciplined", "traceable", "ptpValid"};
        for (int i = 0; i < 4; i++) {
            bool v = false;
            if ((present || j.get(bits[i])) && !boolean(bits[i], &v)) return false;
            if (v) a.flags |= (uint8_t)(0x80 >> i);
        }
        if (present || j.get("timelineId")) {
            const Json* y = j.get("timelineId");
            if (!y || y->type != Json::Type::string || !hcdesc::parse_timeline_text(y->s, &a.value))
                return *err = "missing or bad \"timelineId\"", false;
        }
        if (present || j.get("de90k")) {
            if (!need_u("de90k", 0xFFFFFFFFULL, &u)) return false;
            a.dts_minus_pts_90k = (int32_t)(uint32_t)u;
        }
        if (j.get("flagsRest")) {
            if (!need_u("flagsRest", 0xFF, &u) || (u & ~(uint64_t)DECL_FLAGS_REST)) return *err = "bad \"flagsRest\"", false;
            a.flags |= (uint8_t)u;
        }
        out->push_back(a);
    }
    int given = 0;
    for (const char* k : kDecl2Keys) {
        allowed.push_back(k);
        given += j.get(k) != nullptr;
    }
    if (given != 0 && given != 7) return *err = "the decl2 fields are all given or none", false;
    if (!decl && given == 0) return *err = "a decl2 line needs its fields", false;
    if (given) {
        TraceRecord b;
        b.arrival_ns = t;
        b.kind = TraceKind::decl2;
        uint64_t ver, sync, tai, dom, cls, seq;
        if (!need_u("hcVersion", 0xFF, &ver) || !need_u("syncSource", 0xFF, &sync) ||
            !need_u("taiUtcOffsetS", 0xFF, &tai) || !need_u("ptpDomain", 0xFF, &dom) ||
            !need_u("clockErrorClass", 0xFF, &cls) || !need_u("epochSeq", 0xFFFF, &seq))
            return false;
        const Json* g = j.get("gmIdentity");
        if (g->type != Json::Type::string || !hcdesc::parse_gm(g->s, &b.value)) return *err = "bad \"gmIdentity\"", false;
        b.pid = (uint16_t)seq;
        b.flags = (uint8_t)cls;
        b.dts_minus_pts_90k = (int32_t)(uint32_t)(sync | dom << 8 | ver << 16 | tai << 24);
        out->push_back(b);
    }
    for (const auto& kv : j.keys)
        if (std::find(allowed.begin(), allowed.end(), kv.first) == allowed.end())
            return *err = "unknown key \"" + kv.first + "\"", false;
    return true;
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
        std::fprintf(stderr, "mrts_cli: %s: not an .stct trace of version %u to %u\n", path.c_str(), TRACE_VERSION_MIN,
                     TRACE_VERSION);
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
    for (size_t i = 0; i < recs.size(); i++) {
        const TraceRecord& r = recs[i];
        const bool pair = r.kind == TraceKind::decl && i + 1 < recs.size() && recs[i + 1].kind == TraceKind::decl2 &&
                          recs[i + 1].arrival_ns == r.arrival_ns;
        const std::string line = r.kind == TraceKind::decl    ? decl_json(r, pair ? &recs[i + 1] : nullptr)
                                 : r.kind == TraceKind::decl2 ? decl2_alone_json(r)
                                                              : record_json(r);
        std::printf("%s\n", line.c_str());
        i += pair;
    }
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
        const Json* k = nullptr;
        bool ok = parse_json(l, &j, &err);
        if (ok && j.type == Json::Type::object && (k = j.get("kind")) && k->type == Json::Type::string &&
            (k->s == "decl" || k->s == "decl2"))
            ok = decl_from_json(j, k->s == "decl", &recs, &err);
        else if (ok && (ok = record_from_json(j, &r, &err)))
            recs.push_back(r);
        if (!ok) {
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", argv[1], line, err.c_str());
            return 1;
        }
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
    {"step_fall_hold_ns", &ClockLockConfig::step_fall_hold_ns, nullptr},
    {"lost_ns", &ClockLockConfig::lost_ns, nullptr},
    {"residual_window_ns", &ClockLockConfig::residual_window_ns, nullptr},
    {"pcr_interval_fail_ns", nullptr, &PcrValidatorConfig::pcr_interval_fail_ns},
    {"pcr_interval_cap_ns", nullptr, &PcrValidatorConfig::pcr_interval_cap_ns},
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
    {"cadence_factor", nullptr, &PcrValidatorConfig::cadence_factor},
    {"cadence_intervals", nullptr, &PcrValidatorConfig::cadence_intervals},
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
    // Trust (p5-6b): the selection, L, tau, the local house-clock, and TrustConfig's constants.
    struct TrustKnob {
        const char* name;
        int64_t TrustConfig::*i64;
        int TrustConfig::*i;
    };
    static const TrustKnob kTrust[] = {
        {"l_ns", &TrustConfig::l_ns, nullptr}, {"tau_ns", &TrustConfig::tau_ns, nullptr},
        {"trust.neg_base_ns", &TrustConfig::neg_base_ns, nullptr}, {"trust.bad_pcrs", nullptr, &TrustConfig::bad_pcrs},
        {"trust.decide_pcrs", nullptr, &TrustConfig::decide_pcrs},
        {"trust.decide_max_ns", &TrustConfig::decide_max_ns, nullptr},
        {"trust.decide_max_bytes", &TrustConfig::decide_max_bytes, nullptr},
        {"trust.qualify_ns", &TrustConfig::qualify_ns, nullptr},
        {"trust.return_qualified_ns", &TrustConfig::return_qualified_ns, nullptr},
        {"trust.return_gap_wait_ns", &TrustConfig::return_gap_wait_ns, nullptr},
        {"trust.pmt_stale_ns", &TrustConfig::pmt_stale_ns, nullptr},
        {"trust.converge_div", &TrustConfig::converge_div, nullptr}};
    for (const TrustKnob& n : kTrust) {
        if (key != n.name) continue;
        found = true;
        ok = parse_int(v, &x) && (n.i64 || (x >= INT32_MIN && x <= INT32_MAX));
        if (ok && n.i64) c.trust.*n.i64 = x;
        if (ok && n.i) c.trust.*n.i = (int)x;
    }
    if (key == "timing_mode") {
        found = true;
        ok = v == "restamp" || v == "trust";
        c.timing_mode = v == "trust" ? TimingMode::trust : TimingMode::restamp;
    } else if (key == "clock_e_ns") {
        found = true;
        ok = parse_int(v, &c.house_clock.e_ns);
    } else if (key == "clock_error_us") {
        found = true;
        ok = parse_int(v, &x);
        if (x < 0) c.house_clock.error_us.reset();   // -1: unknown
        else c.house_clock.error_us = x;
    } else if (key == "clock_seq") {
        found = true;
        ok = parse_int(v, &x) && x >= 0 && x <= UINT32_MAX;
        c.house_clock.seq = x;
    } else if (key == "clock_disciplined") {
        found = true;
        ok = parse_flag(v, &c.house_clock.disciplined);
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
    std::map<int, int> pcr_pid_program;   // every PID a program's PSI named its PCR PID
    std::map<int, uint64_t> pcr_flagged;  // per PID: written PCRs with discontinuity_indicator
    long first_diff = -1;                 // first record the replay recorded otherwise; -1: none
    bool trust = false;                   // timing_mode trust: the summary shows each program's gate
    uint64_t out_cc_lost = 0;             // CC errors in the output
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
                "\"gap-ns\":%lld,\"dropped-ns\":%lld,\"house-ns\":%lld,\"epoch\":%u,\"value-ns\":%lld",
                (long long)t, event_kind_name(e.kind), e.program, e.pid, jstr(e.reason ? e.reason : "").c_str(),
                (long long)e.gap_ns, (long long)e.dropped_ns, (long long)e.house_ns, e.epoch, (long long)e.value_ns);
    if (e.kind == RestampCore::Event::Kind::trust_switch)
        std::printf(",\"state\":\"%s\",\"failed\":%s", e.state, jstr(e.failed).c_str());
    std::printf("}\n");
}

void print_stats(int64_t t, const RestampCore::Stats& s) {
    for (const RestampCore::ProgramStats& p : s.programs) {
        const VirtualStc::Stats& c = p.clock;
        std::printf("{\"msg\":\"mrtsrestamp-stats\",\"t\":%lld,\"program\":%d,\"state\":\"%s\",\"reason\":\"%s\","
                    "\"ppb\":%lld,\"offset-drift-ns\":%lld,\"residual-min-ns\":%lld,\"residual-p50-ns\":%lld,"
                    "\"residual-p99-ns\":%lld,\"residual-max-ns\":%lld,\"residual-count\":%u,"
                    "\"pcr-interval-max-ns\":%lld,\"cadence-warning\":%s,\"rate-warning\":%s,\"relocks\":%llu,"
                    "\"epoch\":%u,\"gaps\":%llu,\"gap-ns-total\":%lld,\"dropped-pes\":%llu,\"dropped-ns-total\":%lld,"
                    "\"cc-lost\":%llu,\"desync-bytes\":%llu,\"pcr-cadence-ns\":%lld,\"pcr-gap-max-ns\":%lld}\n",
                    (long long)t, p.program, state_name(c.state), reason_name(c.reason), (long long)c.ppb,
                    (long long)c.offset_drift_ns, (long long)c.residual.min_ns, (long long)c.residual.p50_ns,
                    (long long)c.residual.p99_ns, (long long)c.residual.max_ns, c.residual.count,
                    (long long)c.pcr_interval_max_ns, c.cadence_warning ? "true" : "false",
                    c.rate_warning ? "true" : "false", (unsigned long long)c.relocks, c.epoch,
                    (unsigned long long)p.gaps, (long long)p.gap_ns_total, (unsigned long long)p.dropped_pes,
                    (long long)p.dropped_ns_total, (unsigned long long)s.cc_lost, (unsigned long long)s.desync_bytes,
                    (long long)c.pcr_cadence_ns, (long long)c.pcr_gap_max_ns);
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
            if (r.value & TRACE_PSI_PCR) run.pcr_pid_program[r.pid] = program;
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
        walker.feed(out.data(), out.size(), [&](PacketView& v) {
            if (v.af_pcr && v.af_discontinuity) run.pcr_flagged[v.pid]++;
            units.feed(v, cc.feed(v), got);
        });
        take();
        run.t_end = std::max(run.t_end, b.arrival_ns);
    }
    units.flush(got);
    take();
    run.final_stats = core.stats();
    run.trust = o.cfg.timing_mode == TimingMode::trust;
    run.out_cc_lost = cc.lost();
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
    int backlog = 0;                      // gaps and overlaps with reason backlog: a stale run's
    std::vector<std::string> reasons;     // relock reasons, in order
    uint32_t epoch = 0;
    int64_t gap_ns = 0, gap_min = 0, gap_max = 0, overlap_ns = 0;
    std::map<int, int> gaps_by_pid;
    uint64_t dropped_pes = 0;
    int64_t dropped_ns = 0;
    int64_t locked_at = -1;               // first stats line locked, ns from the start
    std::string final_state;
    int64_t final_ppb = 0;
    int64_t pcr_cadence = 0;              // the final stats line's (B-86)
    int64_t ppb_min = 0, ppb_max = 0;     // over the stats lines while locked
    int64_t residual_min = 0;             // lowest residual-min of a locked line
    bool any_locked = false, cadence_warning = false;
    // The offset drift's speed over MAPPING_WINDOW_NS while locked on one epoch. It moves
    // at bucket closes, so the window reads up to one bucket's travel high (1/30).
    int64_t mapping_ppb_max = 0;
    uint64_t pes_in = 0, pes_out = 0, backward = 0;
    uint64_t pcr_flagged = 0;             // PCRs written with discontinuity_indicator (B-84)
    int64_t lead_max = INT64_MIN;         // the highest house PTS - arrival of a PES kept
    // ε on the last stats line at each convergence mark the trace reaches (the sweep's
    // drift criterion, part 4.3).
    int64_t ppb_at[4] = {0, 0, 0, 0};
    bool has_at[4] = {false, false, false, false};
    // Trust (p5-6b): the states entered in order, the switches, the gate at the end.
    bool trust = false;
    std::vector<std::string> trust_states;
    int trust_switches = 0;
    std::string trust_final, trust_failed;
    int64_t trust_k = 0;
    uint64_t out_cc_lost = 0;
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
            case RestampCore::Event::Kind::trust_switch:
                s.trust_states.push_back(e.state);
                s.trust_switches += !std::strncmp(e.reason, "switch-to-", 10);
                break;
            default: s.psi++; break;
        }
        if ((e.kind == RestampCore::Event::Kind::gap || e.kind == RestampCore::Event::Kind::overlap) && e.reason &&
            !std::strcmp(e.reason, "backlog"))
            s.backlog++;
    }
    for (const RestampCore::ProgramStats& p : run.final_stats.programs) {
        if (p.program != program) continue;
        s.epoch = p.clock.epoch;
        s.final_state = state_name(p.clock.state);
        s.final_ppb = p.clock.ppb;
        s.pcr_cadence = p.clock.pcr_cadence_ns;
        s.dropped_pes = p.dropped_pes;
        s.dropped_ns = p.dropped_ns_total;
        if (run.trust && p.has_trust) {
            s.trust = true;
            s.trust_final = trust_state_name(p.trust.state);
            s.trust_failed = p.trust.failed ? p.trust.failed : "";
            s.trust_k = p.trust.k_ns;
        }
    }
    s.out_cc_lost = run.out_cc_lost;
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
    for (const auto& kv : run.pcr_flagged) {
        const auto it = run.pcr_pid_program.find(kv.first);
        if (it != run.pcr_pid_program.end() && it->second == program) s.pcr_flagged += kv.second;
    }
    return s;
}

// One program's facts as JSON: the summary's program objects and each sweep line's.
void print_program(const ProgramSum& s) {
    std::printf("{\"program\":%d,\"relocks\":%d,\"relockReasons\":[", s.program, s.relocks);
    for (size_t k = 0; k < s.reasons.size(); k++) std::printf("%s%s", k ? "," : "", jstr(s.reasons[k]).c_str());
    std::printf("],\"epochs\":%u,\"degraded\":%d,\"recovered\":%d,\"envelopeSteps\":%d,\"leadClamps\":%d,"
                "\"backlogEvents\":%d,\"gaps\":%d,"
                "\"gapNsTotal\":%lld,\"gapNsMin\":%lld,\"gapNsMax\":%lld,\"overlaps\":%d,\"overlapNs\":%lld,"
                "\"droppedPes\":%llu,\"droppedNsTotal\":%lld,\"lockedAtNs\":%lld,\"finalState\":\"%s\","
                "\"finalPpb\":%lld,\"lockedPpbMin\":%lld,\"lockedPpbMax\":%lld,\"residualMinNs\":%lld,"
                "\"cadenceWarning\":%s,\"mappingPpbMax\":%lld,\"pesIn\":%llu,\"pesOut\":%llu,\"backward\":%llu,"
                "\"leadMaxNs\":%lld,\"pcrFlagged\":%llu,\"pcrCadenceNs\":%lld,"
                "\"ppbAtS\":{",
                s.epoch, s.degraded, s.recovered, s.steps, s.clamps, s.backlog, s.gaps, (long long)s.gap_ns,
                (long long)s.gap_min, (long long)s.gap_max, s.overlaps, (long long)s.overlap_ns,
                (unsigned long long)s.dropped_pes, (long long)s.dropped_ns, (long long)s.locked_at,
                s.final_state.c_str(), (long long)s.final_ppb,
                (long long)s.ppb_min, (long long)s.ppb_max, (long long)s.residual_min,
                s.cadence_warning ? "true" : "false", (long long)s.mapping_ppb_max, (unsigned long long)s.pes_in,
                (unsigned long long)s.pes_out, (unsigned long long)s.backward,
                (long long)(s.lead_max == INT64_MIN ? 0 : s.lead_max), (unsigned long long)s.pcr_flagged,
                (long long)s.pcr_cadence);
    for (int k = 0, n = 0; k < 4; k++)
        if (s.has_at[k]) std::printf("%s\"%lld\":%lld", n++ ? "," : "", (long long)PPB_MARKS_S[k], (long long)s.ppb_at[k]);
    std::printf("}");
    if (s.trust) {
        std::printf(",\"trust\":{\"states\":[");
        for (size_t k = 0; k < s.trust_states.size(); k++)
            std::printf("%s\"%s\"", k ? "," : "", s.trust_states[k].c_str());
        std::printf("],\"switches\":%d,\"finalState\":\"%s\",\"failed\":%s,\"kNs\":%lld,\"outCcLost\":%llu}",
                    s.trust_switches, s.trust_final.c_str(), jstr(s.trust_failed).c_str(), (long long)s.trust_k,
                    (unsigned long long)s.out_cc_lost);
    }
    std::printf("}");
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
                                      "gapsPerPid", "ppm", "leadMaxMs", "config", "trustStates", "trustFinalState",
                                      "trustFailed"};
    const char* counts[] = {"relocks", "epochs", "degraded", "recovered", "envelopeSteps", "gaps", "overlaps",
                            "droppedPes", "droppedMs", "psiChanges", "leadClamps", "backlogEvents", "pcrFlagged",
                            "pcrCadenceMs", "trustSwitches", "pesLost", "outCcLost"};
    const double vals[] = {(double)s.relocks, (double)s.epoch, (double)s.degraded, (double)s.recovered,
                           (double)s.steps, (double)s.gaps, (double)s.overlaps, (double)s.dropped_pes,
                           s.dropped_ns / 1e6, (double)s.psi, (double)s.clamps, (double)s.backlog,
                           (double)s.pcr_flagged, s.pcr_cadence / 1e6, (double)s.trust_switches,
                           (double)s.pes_in - (double)s.pes_out, (double)s.out_cc_lost};
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
    if (const Json* j = x.get("trustStates")) {
        std::vector<std::string> want;
        for (const Json& r : j->items) want.push_back(r.s);
        if (j->type != Json::Type::array || want != s.trust_states) {
            std::string got;
            for (const std::string& r : s.trust_states) got += (got.empty() ? "" : ",") + r;
            fail.push_back("trustStates: [" + got + "]");
        }
    }
    if (const Json* j = x.get("trustFinalState"))
        if (j->s != s.trust_final) fail.push_back("trustFinalState: " + s.trust_final + ", want " + j->s);
    if (const Json* j = x.get("trustFailed"))
        if (j->s != s.trust_failed) fail.push_back("trustFailed: " + s.trust_failed + ", want " + j->s);
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
            const Json* state = w.get("state");
            for (const auto& kv : w.keys)
                if (kv.first != "kind" && kv.first != "reason" && kv.first != "pid" && kv.first != "atS" &&
                    kv.first != "gapMs" && kv.first != "droppedMs" && kv.first != "state")
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
                        (!drop || range_ok(*drop, e.dropped_ns / 1e6, &want)) &&
                        (!state || state->s == e.state);
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
    "  (mode, add_base_time, base_time_ns, offset_ns, pid_trims=<pid>=<ns>;...), Trust's\n"
    "  (timing_mode=restamp|trust, l_ns, tau_ns, clock_e_ns, clock_seq, clock_disciplined,\n"
    "  clock_error_us, trust.<TrustConfig field>; an expectation's \"config\" object first) and every\n"
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
    // An expectation's "config" (a Trust replay's selection and clock, p5-6b) first, then --config.
    if (const Json* c = expect_path.empty() ? nullptr : expect.get("config")) {
        for (const auto& kv : c->keys) {
            std::string err;
            const std::string v = kv.second.type == Json::Type::boolean ? (kv.second.b ? "true" : "false") : kv.second.s;
            if (!set_knob(o.cfg, kv.first, v, &err)) {
                std::fprintf(stderr, "mrts_cli: %s: %s\n", expect_path.c_str(), err.c_str());
                return 1;
            }
        }
    }
    for (const auto& kv : config) {
        std::string err;
        if (!set_knob(o.cfg, kv.first, kv.second, &err)) {
            std::fprintf(stderr, "mrts_cli: %s\n", err.c_str());
            return 2;
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

// --- rebase: a recording's house time moved onto another clock (WI-P3-3) ----------------

// One bus buffer of a recording's sidecar (<name>.bus.jsonl): its bytes in the .ts, its
// timestamps in ns (-1: none) and its GstBufferFlags.
struct BusLine {
    uint64_t off = 0, len = 0, flags = 0;
    int64_t pts = -1, dts = -1, dur = -1;
};

std::string bus_json(const BusLine& b) {
    auto t = [](int64_t v) { return v < 0 ? std::string("null") : std::to_string(v); };
    return "{\"off\":" + std::to_string(b.off) + ",\"len\":" + std::to_string(b.len) + ",\"pts\":" + t(b.pts) +
           ",\"dts\":" + t(b.dts) + ",\"dur\":" + t(b.dur) + ",\"flags\":" + std::to_string(b.flags) + "}";
}

bool bus_from_json(const Json& j, BusLine* out, std::string* err) {
    if (j.type != Json::Type::object) return *err = "not an object", false;
    BusLine b;
    for (const auto& kv : j.keys) {
        const std::string& k = kv.first;
        const Json& v = kv.second;
        bool ok;
        if (k == "off") ok = v.u64(&b.off);
        else if (k == "len") ok = v.u64(&b.len);
        else if (k == "flags") ok = v.u64(&b.flags);
        else if (k == "pts" || k == "dts" || k == "dur") {
            int64_t* t = k == "pts" ? &b.pts : k == "dts" ? &b.dts : &b.dur;
            ok = v.type == Json::Type::null || (v.i64(t) && *t >= 0);
        } else {
            return *err = "unknown key \"" + k + "\"", false;
        }
        if (!ok) return *err = "bad \"" + k + "\"", false;
    }
    if (!j.get("off") || !j.get("len") || !j.get("flags")) return *err = "missing \"off\", \"len\" or \"flags\"", false;
    *out = b;
    return true;
}

// A sidecar's lines, each buffer inside the `size` bytes of its recording; false, the reason
// printed, on any bad line.
bool read_bus(const std::string& path, const std::string& ts_name, size_t size, std::vector<BusLine>* bus) {
    std::string text;
    if (!read_file(path, &text)) {
        std::perror(path.c_str());
        return false;
    }
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
        BusLine b;
        if (parse_json(l, &j, &err) && bus_from_json(j, &b, &err) && (b.off > size || b.len > size - b.off))
            err = "a buffer past the end of " + ts_name;
        if (!err.empty()) {
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", path.c_str(), line, err.c_str());
            return false;
        }
        bus->push_back(b);
    }
    return true;
}

bool write_bytes(const std::string& path, const char* data, size_t n) {
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    const bool ok = std::fwrite(data, 1, n, f) == n;
    if (std::fclose(f) == 0 && ok) return true;
    std::remove(path.c_str());
    return false;
}

const char kRebaseUsage[] =
    "usage: mrts_cli rebase in.ts out.ts --to-ns T [--bus in.bus.jsonl out.bus.jsonl]\n"
    "  Moves a recording onto another house clock by one shift, a whole number of 100 us, so\n"
    "  its first PES lands within 50 us of house time T (ns): every PES PTS/DTS and PCR base\n"
    "  mod 2^33 (a header split over two packets too), every other byte kept; --bus moves the\n"
    "  sidecar's pts and dts by the same shift in ns, exactly, whatever its buffers' sizes. The\n"
    "  bus formula on the result is PES - 1 h. Prints one JSON line: the first PES, the shift,\n"
    "  what was rewritten.\n";

int rebase_main(int argc, char** argv) {
    std::string in, out, bus_in, bus_out;
    int64_t to = 0;
    bool have_to = false;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--to-ns" && i + 1 < argc) {
            // Any value: a recording of another clock's PES may sit before house time 0.
            have_to = parse_int(argv[++i], &to) && to > INT64_MIN / 2 && to < INT64_MAX / 2;
            if (!have_to) return std::fputs(kRebaseUsage, stderr), 2;
        } else if (a == "--bus" && i + 2 < argc) {
            bus_in = argv[++i];
            bus_out = argv[++i];
        } else if (a[0] != '-' && in.empty()) {
            in = a;
        } else if (a[0] != '-' && out.empty()) {
            out = a;
        } else {
            return std::fputs(kRebaseUsage, stderr), 2;
        }
    }
    if (in.empty() || out.empty() || !have_to) return std::fputs(kRebaseUsage, stderr), 2;
    std::string ts;
    if (!read_file(in, &ts)) {
        std::perror(in.c_str());
        return 1;
    }
    uint8_t* data = reinterpret_cast<uint8_t*>(&ts[0]);
    int pid = -1;
    const int64_t p0 = first_pes_pts(data, ts.size(), &pid);
    if (p0 < 0) {
        std::fprintf(stderr, "mrts_cli: %s: no PES with a PTS\n", in.c_str());
        return 1;
    }
    std::vector<BusLine> bus;
    if (!bus_in.empty() && !read_bus(bus_in, in, ts.size(), &bus)) return 1;
    // The first PES's house time on the recording's own clock: unwrapped near its first stamp.
    int64_t ref = to;
    for (const BusLine& b : bus)
        if (b.pts >= 0) {
            ref = b.pts;
            break;
        }
    const int64_t from = house_from_mux_pts(p0, ref);
    // 100 us is 9 ticks: on that grid the PES and the sidecar's ns move by the same exact amount.
    const int64_t step = 100000, d = to - from;
    const int64_t shift_ns = (d >= 0 ? (d + step / 2) / step : -((-d + step / 2) / step)) * step;
    const int64_t shift_90k = shift_ns / step * 9;
    for (BusLine& b : bus)
        for (int64_t* t : {&b.pts, &b.dts}) {
            if (*t < 0) continue;
            *t += shift_ns;
            if (*t < 0) {
                std::fprintf(stderr, "mrts_cli: %s: a buffer would land before house time 0\n", bus_in.c_str());
                return 1;
            }
        }
    const TsRewrite r = rebase_ts(data, ts.size(), shift_90k);
    std::string lines;
    for (const BusLine& b : bus) lines += bus_json(b) + "\n";
    if (!write_bytes(out, ts.data(), ts.size()) ||
        (!bus_out.empty() && !write_bytes(bus_out, lines.data(), lines.size()))) {
        std::fprintf(stderr, "mrts_cli: writing %s failed\n", out.c_str());
        return 1;
    }
    std::printf("{\"msg\":\"rebase\",\"firstPid\":%d,\"firstPts\":%lld,\"fromNs\":%lld,\"toNs\":%lld,"
                "\"shiftNs\":%lld,\"shift90k\":%lld,\"pes\":%llu,\"pcr\":%llu,\"spans\":%llu,\"broken\":%llu,"
                "\"busLines\":%zu}\n",
                pid, (long long)p0, (long long)from, (long long)(from + shift_ns), (long long)shift_ns,
                (long long)shift_90k, (unsigned long long)r.pes, (unsigned long long)r.pcr,
                (unsigned long long)r.spans, (unsigned long long)r.broken, bus.size());
    return 0;
}

// --- demux: a recording through mrts::DemuxCore, as .demux.jsonl (WI-P3-1) --------------

const char kDemuxUsage[] =
    "usage: mrts_cli demux in.ts [--chunk N] [--media M] [--select CAPS] [--program P] [--house-ns T]\n"
    "                            [--bus in.bus.jsonl]\n"
    "  Every event of mrts::DemuxCore on the recording, then its counters, as .demux.jsonl lines\n"
    "  (py/demux_core.py's, the reference): fed in N-byte pieces (default 1316), or per bus buffer\n"
    "  of a sidecar (its GAP buffers as markers, DISCONT kept), at house time T (default: the first\n"
    "  PES - 1 h). M: of video,audio,private,subpicture (default all); CAPS: audio/x-smpte-302m.\n";

int demux_main(int argc, char** argv) {
    std::string in, bus_in;
    DemuxCore::Config cfg;
    int64_t chunk = 1316, house = -1, v = 0;
    bool have_house = false;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        const bool arg = i + 1 < argc;
        if (a == "--chunk" && arg && parse_int(argv[i + 1], &chunk) && chunk >= 1) {
            i++;
        } else if (a == "--media" && arg) {
            cfg.media_mask = 0;
            const std::string m = argv[++i];
            for (size_t at = 0; at <= m.size();) {
                size_t comma = m.find(',', at);
                if (comma == std::string::npos) comma = m.size();
                const std::string name = m.substr(at, comma - at);
                at = comma + 1;
                EsClass c;
                if (name.empty()) continue;
                if (!es_class_from_name(name, &c)) return std::fputs(kDemuxUsage, stderr), 2;
                cfg.media_mask |= media_bit(c);
            }
        } else if (a == "--select" && arg) {
            cfg.select = argv[++i];
        } else if (a == "--program" && arg && parse_int(argv[i + 1], &v) && v >= INT32_MIN && v <= INT32_MAX) {
            cfg.program = (int)v;
            i++;
        } else if (a == "--house-ns" && arg && parse_int(argv[i + 1], &house)) {
            have_house = true;
            i++;
        } else if (a == "--bus" && arg) {
            bus_in = argv[++i];
        } else if (a[0] != '-' && in.empty()) {
            in = a;
        } else {
            return std::fputs(kDemuxUsage, stderr), 2;
        }
    }
    if (in.empty()) return std::fputs(kDemuxUsage, stderr), 2;
    if (!DemuxCore::selectable(cfg.select)) {
        std::fprintf(stderr, "select \"%s\" names no stream the demux can select\n", cfg.select.c_str());
        return 2;
    }
    std::string ts;
    if (!read_file(in, &ts)) {
        std::perror(in.c_str());
        return 1;
    }
    std::vector<BusLine> bus;
    if (!bus_in.empty() && !read_bus(bus_in, in, ts.size(), &bus)) return 1;
    const uint8_t* d = reinterpret_cast<const uint8_t*>(ts.data());
    const int64_t now = have_house ? house : first_pes_house_ns(d, ts.size());
    DemuxCore core(cfg);
    std::vector<DemuxEvent> out;
    std::string text;
    auto print = [&]() {
        for (const DemuxEvent& e : out) text += demux_jsonl(e) + "\n";
        out.clear();
    };
    if (bus_in.empty()) {
        for (size_t at = 0; at < ts.size(); at += (size_t)chunk) {
            core.feed(d + at, std::min((size_t)chunk, ts.size() - at), false, now, out);
            print();
        }
    } else {
        for (const BusLine& b : bus) {
            if (b.flags & 2048)                   // GST_BUFFER_FLAG_GAP: a marker, its PTS the end
                core.marker(d + b.off, b.len, b.pts, out);
            else
                core.feed(d + b.off, b.len, (b.flags & 64) != 0, now, out);
            print();
        }
    }
    core.drain(out);
    print();
    text += demux_jsonl(core.counters()) + "\n";
    std::fwrite(text.data(), 1, text.size(), stdout);
    return 0;
}

// --- asrc: a call sequence through mrts::AsrcServo and its device term (WI-P3-5, B-166) -----

const char kAsrcUsage[] =
    "usage: mrts_cli asrc seq.txt|-\n"
    "  Replays a call sequence and prints what py/asrc_bypass_ref.py's replay() prints for it:\n"
    "    cfg IN OUT BYPASS_PPB DEVICE DELAY [FIRST_FIT]   the servo (DEVICE 0/1)\n"
    "    b PTS FRAMES DISCONT DEV_PPB [DRAIN_PPB]         push(); prints the command\n"
    "    o K / t K                                        produced(K) / tail_produced(K)\n"
    "    g                                                end_epoch(); prints its result\n"
    "    s DEV MONO                                       a timer read of the device sink's clock\n"
    "    r MONO                                           the sink's ring acquired again: a restart\n"
    "    p                                                prints the stats and the device term\n";

// The element's glue: a relock-device tells the servo before its next push (B-148's A1).
void device_recalibrate(AsrcDeviceTerm* term, AsrcServo* sv) {
    if (term->take_recalibrated()) sv->device_recalibrated();
}

int asrc_main(int argc, char** argv) {
    if (argc != 2) return std::fputs(kAsrcUsage, stderr), 2;
    std::string text;
    if (!read_file(argv[1], &text)) {
        std::perror(argv[1]);
        return 1;
    }
    std::unique_ptr<AsrcServo> sv;
    std::unique_ptr<AsrcDeviceTerm> term;
    std::vector<AsrcDeviceEvent> devents;
    std::string out;
    char line[512];
    uint64_t n = 0;
    size_t at = 0, lineno = 0;
    while (at < text.size()) {
        size_t nl = text.find('\n', at);
        if (nl == std::string::npos) nl = text.size();
        std::vector<std::string> f;
        for (size_t i = at; i < nl;) {
            while (i < nl && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r')) i++;
            size_t j = i;
            while (j < nl && text[j] != ' ' && text[j] != '\t' && text[j] != '\r') j++;
            if (j > i) f.push_back(text.substr(i, j - i));
            i = j;
        }
        at = nl + 1;
        lineno++;
        if (f.empty() || f[0][0] == '#') continue;
        std::vector<int64_t> v(f.size(), 0);
        for (size_t i = 1; i < f.size(); i++)
            if (!parse_int(f[i], &v[i])) {
                std::fprintf(stderr, "mrts_cli asrc: line %zu: not a number: %s\n", lineno, f[i].c_str());
                return 2;
            }
        const std::string& k = f[0];
        if (k != "cfg" && !sv) {
            std::fprintf(stderr, "mrts_cli asrc: line %zu: no cfg line yet\n", lineno);
            return 2;
        }
        if (k == "cfg" && f.size() >= 6) {
            AsrcServoConfig c;
            c.lock = v[3] > 0 ? asrc_decode_lock_config() : asrc_lock_config();
            if (f.size() > 6) c.lock.rate_buckets_min = (int)v[6];
            c.bypass_ppb = v[3];
            c.device = v[4] != 0;
            sv.reset(new AsrcServo((int32_t)v[1], (int32_t)v[2], c));
            sv->set_delay((uint32_t)v[5]);
            term.reset(new AsrcDeviceTerm());
        } else if (k == "b" && (f.size() == 5 || f.size() == 6)) {
            const AsrcServo::Command c = sv->push(v[1], (uint32_t)v[2], v[3] != 0, v[4], -1, f.size() == 6 ? v[5] : 0);
            const AsrcServo::Stats s = sv->stats();
            std::snprintf(line, sizeof line,
                          "b %llu %s in=%d out=%d relock=%d skip=%u pass=%d engage=%d drain=%d gap=%d t0=%lld "
                          "m=%llu phase=%lld ratio=%lld src=%lld\n",
                          (unsigned long long)n++, asrc_mode_name(s.mode), c.in_rate, c.out_rate, (int)c.relock,
                          c.skip, (int)c.pass, (int)c.engage, (int)c.drain, (int)c.gap, (long long)sv->t0(),
                          (unsigned long long)sv->epoch_frames(), (long long)s.phase_err_ns,
                          (long long)s.ratio_ppb, (long long)s.source_ppb);
            out += line;
            for (const AsrcEvent& e : sv->take_events()) {
                std::snprintf(line, sizeof line, "e %s %s %lld %lld %lld %lld %lld %d\n", asrc_event_name(e.kind),
                              e.reason && *e.reason ? e.reason : "-", (long long)e.house_ns, (long long)e.value,
                              (long long)e.dropped_ns, (long long)e.phase_ns, (long long)e.lost_frames,
                              (int)e.rate_known);
                out += line;
            }
        } else if (k == "o" && f.size() == 2) {
            sv->produced((uint32_t)v[1]);
        } else if (k == "t" && f.size() == 2) {
            sv->tail_produced((uint32_t)v[1]);
        } else if (k == "g" && f.size() == 1) {
            const bool drain = sv->end_epoch();
            std::snprintf(line, sizeof line, "g %d %lld\n", (int)drain, (long long)sv->tail_pts_at(0));
            out += line;
        } else if (k == "s" && f.size() == 3) {
            if (!term->rendering()) term->start(v[2], &devents);
            term->sample(v[1], v[2], -1, -1, &devents);
            device_recalibrate(term.get(), sv.get());
            devents.clear();
        } else if (k == "r" && f.size() == 2) {
            term->stop(v[1]);
            term->start(v[1], &devents);
            device_recalibrate(term.get(), sv.get());
            devents.clear();
        } else if (k == "p" && f.size() == 1) {
            const AsrcServo::Stats s = sv->stats();
            std::snprintf(line, sizeof line,
                          "p state=%s ratio-ppb=%lld phase-err-ns=%lld relocks=%llu in-frames=%llu out-frames=%llu "
                          "discont-in=%llu dropped-frames=%llu mode=%s source-ppb=%lld gaps=%llu lost-frames=%lld "
                          "rate-known=%d drain-ppb=%lld dev-ppb=%lld dev-rate=%lld dev-lock=%s dev-relocks=%llu\n",
                          asrc_state_name(s.state), (long long)s.ratio_ppb, (long long)s.phase_err_ns,
                          (unsigned long long)s.relocks, (unsigned long long)s.in_frames,
                          (unsigned long long)s.out_frames, (unsigned long long)s.discont_in,
                          (unsigned long long)s.dropped_frames, asrc_mode_name(s.mode), (long long)s.source_ppb,
                          (unsigned long long)s.gaps, (long long)s.lost_frames, (int)s.rate_known,
                          (long long)s.drain_ppb, (long long)term->device_ppb(), (long long)asrc_rate_of(term->device_ppb()),
                          asrc_device_lock_state_name(term->lock_state()),
                          (unsigned long long)(term->stats().relocks_restart + term->stats().relocks_step));
            out += line;
        } else {
            std::fprintf(stderr, "mrts_cli asrc: line %zu: unknown line\n", lineno);
            return 2;
        }
    }
    std::fwrite(out.data(), 1, out.size(), stdout);
    return 0;
}

// --- pace: a call sequence through VideoPace and DisplayRate (WI-P4-3, B-175), video_pace.py lines

bool op_i64(const Json& op, const char* key, int64_t* v, std::string* err) {
    const Json* j = op.get(key);
    if (j && j->i64(v)) return true;
    *err = std::string("\"") + key + "\" must be an integer";
    return false;
}

// Python's bool(): true or a number other than 0.
bool op_flag(const Json& op, const char* key, bool* v, std::string* err) {
    const Json* j = op.get(key);
    int64_t x = 0;
    if (j && j->type == Json::Type::boolean) {
        *v = j->b;
    } else if (j && j->i64(&x)) {
        *v = x != 0;
    } else {
        *err = std::string("\"") + key + "\" must be a number or a boolean";
        return false;
    }
    return true;
}

void print_period(const DisplayPeriod& p) {
    std::printf("{\"period\":%lld,\"short\":%d}\n", (long long)p.period_ns, p.short_span ? 1 : 0);
}

// One op of the sequence; the lines it prints are video_pace.py's, byte for byte.
bool pace_op(const Json& op, VideoPace* pace, DisplayRate* rate,
             std::vector<PresentedSample>* samples, std::vector<int64_t>* times, std::string* err) {
    const Json* kind = op.get("op");
    if (!kind || kind->type != Json::Type::string) {
        *err = "no \"op\"";
        return false;
    }
    const std::string& k = kind->s;
    if (k == "config") {
        int64_t gap = VideoPace::GAP_THRESHOLD_NS;
        if (op.get("gap_threshold") && !op_i64(op, "gap_threshold", &gap, err)) return false;
        *pace = VideoPace(gap);
        *rate = DisplayRate();
    } else if (k == "display") {
        int64_t period = 0;
        DisplaySource source = DisplaySource::none;
        const Json* s = op.get("source");
        if (!op_i64(op, "period", &period, err)) return false;
        if (!s || s->type != Json::Type::string || !parse_display_source(s->s.c_str(), &source)) {
            *err = "\"source\" must be none, nominal or measured";
            return false;
        }
        pace->set_display(period, source);
    } else if (k == "gap") {
        pace->on_gap();
    } else if (k == "drain") {
        int64_t ppb = 0;
        if (!op_i64(op, "ppb", &ppb, err)) return false;
        pace->set_drain(ppb);
    } else if (k == "frame") {
        int64_t pts = 0, dur = 0, arrival = 0;
        bool discont = false, held = false;
        if (!op_i64(op, "pts", &pts, err) || !op_i64(op, "dur", &dur, err) ||
            !op_i64(op, "arrival", &arrival, err) || !op_flag(op, "discont", &discont, err) ||
            (op.get("held") && !op_flag(op, "held", &held, err)))
            return false;
        const PaceDecision d = pace->on_frame(pts, dur, arrival, discont, held);
        std::printf("{\"release\":%lld,\"drop\":%d}\n", (long long)d.release_ns, d.rate_drop ? 1 : 0);
    } else if (k == "take") {
        const PaceSummary s = pace->take();
        std::printf("{\"released\":%llu,\"late\":%llu,\"rate_drops\":%llu,\"gaps_collapsed\":%llu,"
                    "\"behind\":%llu,\"content_period\":%lld,\"display_period\":%lld,"
                    "\"display_source\":\"%s\",\"mean_hold\":%lld,\"drain_drops\":%llu}\n",
                    (unsigned long long)s.released, (unsigned long long)s.late,
                    (unsigned long long)s.rate_drops, (unsigned long long)s.gaps_collapsed,
                    (unsigned long long)s.behind, (long long)s.content_period,
                    (long long)s.display_period, display_source_name(s.display_source),
                    (long long)s.mean_hold, (unsigned long long)s.drain_drops);
    } else if (k == "rate_prior" || k == "rate_refresh") {
        int64_t period = 0;
        if (!op_i64(op, "period", &period, err)) return false;
        if (k == "rate_prior") rate->set_prior(period);
        else rate->set_refresh(period);
    } else if (k == "rate_push") {
        int64_t returned = 0;
        bool pressed = false;
        if (!op_i64(op, "returned", &returned, err) || !op_flag(op, "pressed", &pressed, err))
            return false;
        rate->on_push(returned, pressed);
    } else if (k == "rate_restart") {
        rate->restart();
    } else if (k == "rate") {
        DisplaySource source = DisplaySource::none;
        const int64_t period = rate->period(&source);
        std::printf("{\"rate\":%lld,\"source\":\"%s\",\"achieved\":%lld}\n", (long long)period,
                    display_source_name(source), (long long)rate->achieved());
    } else if (k == "feedback") {
        const Json* pairs = op.get("pairs");
        if (!pairs || pairs->type != Json::Type::array) return *err = "\"pairs\" must be an array", false;
        samples->clear();
        for (const Json& p : pairs->items) {
            PresentedSample x{};
            if (p.type != Json::Type::array || p.items.size() != 2 || !p.items[0].i64(&x.presented_ns) ||
                !p.items[1].i64(&x.seq))
                return *err = "a pair must be [presented ns, seq]", false;
            samples->push_back(x);
        }
        print_period(display_period_from_feedback(samples->data(), samples->size()));
    } else if (k == "returns") {
        const Json* ts = op.get("times");
        int64_t prior = 0;
        if (!ts || ts->type != Json::Type::array) return *err = "\"times\" must be an array", false;
        if (op.get("prior") && !op_i64(op, "prior", &prior, err)) return false;
        times->clear();
        for (const Json& t : ts->items) {
            int64_t v = 0;
            if (!t.i64(&v)) return *err = "a time must be an integer", false;
            times->push_back(v);
        }
        print_period(display_period_from_returns(times->data(), times->size(), prior));
    } else {
        *err = "unknown op \"" + k + "\"";
        return false;
    }
    return true;
}

int pace_main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: mrts_cli pace seq.jsonl|-\n");
        return 2;
    }
    const std::string path = argv[1];
    std::FILE* f = path == "-" ? stdin : std::fopen(path.c_str(), "rb");
    if (!f) {
        std::perror(argv[1]);
        return 1;
    }
    static char out[1 << 16];
    std::setvbuf(stdout, out, _IOFBF, sizeof out);
    VideoPace pace;
    DisplayRate rate;
    std::vector<PresentedSample> samples;
    std::vector<int64_t> times;
    std::string line, err;
    char buf[1 << 16];
    size_t lineno = 0;
    int rc = 0;
    while (rc == 0) {
        line.clear();
        bool got = false;
        while (std::fgets(buf, sizeof buf, f)) {
            got = true;
            line += buf;
            if (!line.empty() && line.back() == '\n') break;
        }
        if (!got) break;
        lineno++;
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        Json op;
        if (!parse_json(line, &op, &err) || !pace_op(op, &pace, &rate, &samples, &times, &err)) {
            std::fflush(stdout);
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", argv[1], lineno, err.c_str());
            rc = 1;
        }
    }
    if (std::ferror(f)) {
        std::perror(argv[1]);
        rc = 1;
    }
    if (f != stdin) std::fclose(f);
    return rc;
}

// --- asrc-device: the device term (WI-P4-4, B-166), py/asrc_device_ref.py's replay format ------

// A config line's fields onto the term's configuration (other keys are labels).
bool device_config(const Json& op, AsrcDeviceConfig* c, std::string* err) {
    struct F {
        const char* key;
        int64_t* v;
    };
    int64_t relock_samples = c->relock_samples;
    const F term[] = {{"sample_ns", &c->sample_ns},   {"settle_ns", &c->settle_ns}, {"relock_ns", &c->relock_ns},
                      {"relock_samples", &relock_samples}, {"flat_den", &c->flat_den}, {"stall_ns", &c->stall_ns},
                      {"waiting_ns", &c->waiting_ns}, {"probe_ns", &c->probe_ns},   {"resume_ns", &c->resume_ns},
                      {"rate_hz", &c->rate_hz},       {"ratio_max_ppm", &c->ratio_max_ppm}};
    for (const F& f : term)
        if (op.get(f.key) && !op_i64(op, f.key, f.v, err)) return false;
    c->relock_samples = (int)relock_samples;
    const Json* lk = op.get("lock");
    if (!lk) return true;
    if (lk->type != Json::Type::object) return *err = "\"lock\" must be an object", false;
    ClockLockConfig& l = c->lock;
    int64_t bmin = l.rate_buckets_min, bmax = l.rate_buckets_max, mads = l.rate_refit_mads, obuck = l.offset_buckets;
    const F lock[] = {{"bucket_ns", &l.bucket_ns},         {"rate_buckets_min", &bmin},
                      {"rate_buckets_max", &bmax},         {"rate_tau_ns", &l.rate_tau_ns},
                      {"rate_warn_ppm", &l.rate_warn_ppm}, {"rate_max_ppm", &l.rate_max_ppm},
                      {"rate_refit_mads", &mads},          {"offset_buckets", &obuck},
                      {"slew_acquire_ppm", &l.slew_acquire_ppm}, {"acquire_ns", &l.acquire_ns},
                      {"slew_track_ppm", &l.slew_track_ppm}, {"step_ns", &l.step_ns},
                      {"step_hold_ns", &l.step_hold_ns},   {"backlog_ns", &l.backlog_ns},
                      {"step_fall_hold_ns", &l.step_fall_hold_ns}, {"lost_ns", &l.lost_ns},
                      {"residual_window_ns", &l.residual_window_ns}};
    for (const F& f : lock)
        if (lk->get(f.key) && !op_i64(*lk, f.key, f.v, err)) return false;
    l.rate_buckets_min = (int)bmin;
    l.rate_buckets_max = (int)bmax;
    l.rate_refit_mads = (int)mads;
    l.offset_buckets = (int)obuck;
    if (lk->get("step_falls") && !op_flag(*lk, "step_falls", &l.step_falls, err)) return false;
    if (l.backlog_ns != 0 || l.step_fall_hold_ns != 0) return *err = "the device lock has no backlog rule", false;
    return true;
}

void print_device_events(const std::vector<AsrcDeviceEvent>& events) {
    for (const AsrcDeviceEvent& e : events) {
        if (e.kind == AsrcDeviceEvent::Kind::relock_device && !std::strcmp(e.reason, "restart"))
            std::printf("{\"event\":\"relock-device\",\"reason\":\"restart\",\"at\":%lld}\n", (long long)e.at);
        else if (e.kind == AsrcDeviceEvent::Kind::relock_device)
            std::printf("{\"event\":\"relock-device\",\"reason\":\"%s\",\"at\":%lld,\"step_ns\":%lld}\n", e.reason,
                        (long long)e.at, (long long)e.value);
        else
            std::printf("{\"event\":\"%s\",\"at\":%lld,\"%s\":%lld}\n", asrc_device_event_name(e.kind),
                        (long long)e.at, e.kind == AsrcDeviceEvent::Kind::device_stalled ? "pending" : "dropped",
                        (long long)e.value);
    }
}

// After a call's events: a relock-device tells the servo (B-148's A1).
void print_recalibrated(AsrcDeviceTerm* t) {
    if (t->take_recalibrated()) std::printf("{\"recalibrated\":1}\n");
}

void print_device_summary(const AsrcDeviceTerm& t) {
    const AsrcDeviceTerm::Stats s = t.stats();
    std::printf("{\"summary\":{\"device_ppb\":%lld,\"device_rate_ppb\":%lld,\"relocks_restart\":%llu,"
                "\"relocks_step\":%llu,\"device_stalls\":%llu,\"dropped\":%lld,\"flushes\":%llu,\"flat_ns\":%lld,"
                "\"fed\":%llu}}\n",
                (long long)s.device_ppb, (long long)s.device_rate_ppb, (unsigned long long)s.relocks_restart,
                (unsigned long long)s.relocks_step, (unsigned long long)s.device_stalls, (long long)s.dropped,
                (unsigned long long)s.flushes, (long long)s.flat_ns, (unsigned long long)s.fed);
}

// One line: an op, or a recorded clock's (tools/output-check/sink_clock_trace.py); the lines it prints are
// asrc_device_ref.py's replay(), byte for byte.
bool device_op(const Json& o, std::unique_ptr<AsrcDeviceTerm>* term, std::unique_ptr<AsrcRenderLateness>* acc,
               std::string* err) {
    const Json* opj = o.get("op");
    const std::string op = opj && opj->type == Json::Type::string ? opj->s : "";
    if (op == "config") {
        if (*term) print_device_summary(**term);
        AsrcDeviceConfig c;
        if (!device_config(o, &c, err)) return false;
        term->reset(new AsrcDeviceTerm(c));
        acc->reset(new AsrcRenderLateness(c.rate_hz));
        return true;
    }
    if (!*term) {
        term->reset(new AsrcDeviceTerm());
        acc->reset(new AsrcRenderLateness((*term)->config().rate_hz));
    }
    AsrcDeviceTerm& t = **term;
    if (op == "rendered") {
        int64_t w = 0, n = 0, pts = 0;
        if (!op_i64(o, "write_pos", &w, err) || !op_i64(o, "n", &n, err) || !op_i64(o, "pts", &pts, err)) return false;
        (*acc)->rendered(w, n, pts);
        return true;
    }
    if (op == "flush") {
        (*acc)->flush();
        return true;
    }
    if (op == "lateness") {
        int64_t now = 0, dev = 0, late = 0;
        if (!op_i64(o, "now", &now, err) || !op_i64(o, "dev", &dev, err)) return false;
        if ((*acc)->at(now, dev, &late)) std::printf("{\"lateness\":%lld}\n", (long long)late);
        else std::printf("{\"lateness\":null}\n");
        return true;
    }
    std::vector<AsrcDeviceEvent> events;
    int64_t dev = 0, mono = 0, in_ppb = 0, pushed = -1, rendered = -1;
    if (op == "start" || op == "stop") {
        if (!op_i64(o, "mono", &mono, err)) return false;
        if (op == "start") t.start(mono, &events);
        else t.stop(mono);
        print_device_events(events);
        if (op == "start") print_recalibrated(&t);
        return true;
    }
    if (op == "sample") {
        if (!t.rendering()) {
            std::printf("{\"refused\":\"sample before start\"}\n");
            return true;
        }
        if (!op_i64(o, "dev", &dev, err) || !op_i64(o, "mono", &mono, err)) return false;
        if (o.get("in_ppb") && !op_i64(o, "in_ppb", &in_ppb, err)) return false;
        if (o.get("pushed") && (!op_i64(o, "pushed", &pushed, err) || !op_i64(o, "rendered", &rendered, err)))
            return false;
    } else if (!op.empty()) {
        return *err = "unknown op \"" + op + "\"", false;
    } else if (o.get("clock_ns")) {
        int64_t next = -1;
        if (o.get("next_sample") && !op_i64(o, "next_sample", &next, err)) return false;
        if (next < 0) return true;   // nothing rendered yet: never read
        if (!op_i64(o, "clock_ns", &dev, err) || !op_i64(o, "mono_ns", &mono, err)) return false;
        if (!t.rendering()) {
            t.start(mono, &events);
            print_device_events(events);
            print_recalibrated(&t);
            events.clear();
        }
    } else {
        const Json* ev = o.get("event");
        if (ev && ev->type == Json::Type::string && ev->s == "restart") {
            if (!op_i64(o, "mono_ns", &mono, err)) return false;
            t.stop(mono);
        }
        return true;
    }
    const bool flush = t.sample(dev, mono, pushed, rendered, &events);
    print_device_events(events);
    print_recalibrated(&t);
    std::printf("{\"mono\":%lld,\"lock\":\"%s\",\"dev_ppb\":%lld,\"ratio_ppb\":%lld,\"stalled\":%d,\"flush\":%d}\n",
                (long long)mono, asrc_device_lock_state_name(t.lock_state()), (long long)t.device_ppb(),
                (long long)t.ratio_ppb(in_ppb), (int)t.stalled(), (int)flush);
    return true;
}

int asrc_device_main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: mrts_cli asrc-device seq.jsonl|-\n");
        return 2;
    }
    std::string text, err;
    if (!read_file(argv[1], &text)) {
        std::perror(argv[1]);
        return 1;
    }
    static char out[1 << 16];
    std::setvbuf(stdout, out, _IOFBF, sizeof out);
    std::unique_ptr<AsrcDeviceTerm> term;
    std::unique_ptr<AsrcRenderLateness> acc;
    size_t at = 0, lineno = 0;
    while (at < text.size()) {
        size_t nl = text.find('\n', at);
        if (nl == std::string::npos) nl = text.size();
        const std::string line = text.substr(at, nl - at);
        at = nl + 1;
        lineno++;
        if (line.find_first_not_of(" \t\r") == std::string::npos) continue;
        Json o;
        if (!parse_json(line, &o, &err) || !device_op(o, &term, &acc, &err)) {
            std::fflush(stdout);
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", argv[1], lineno, err.c_str());
            return 1;
        }
    }
    if (term) print_device_summary(*term);
    return 0;
}

// --- drain: a call sequence through mrts::DrainServo (WI-P4-18, B-179), py/drain_servo.py's lines --------

// One op; the lines it prints are drain_servo.py's replay(), byte for byte.
bool drain_op(const Json& op, DrainServo* s, std::string* err) {
    const Json* kind = op.get("op");
    if (!kind || kind->type != Json::Type::string) return *err = "no \"op\"", false;
    const std::string& k = kind->s;
    int64_t now = 0, v = 0;
    bool flag = false;
    if (k == "config") {
        int64_t start = DrainServo::AUDIO_START_NS, floor = DrainServo::AUDIO_FLOOR_NS;
        bool video = false;
        if ((op.get("video") && !op_flag(op, "video", &video, err)) ||
            (op.get("start") && !op_i64(op, "start", &start, err)) ||
            (op.get("floor") && !op_i64(op, "floor", &floor, err)))
            return false;
        *s = DrainServo(video, start, floor);
    } else if (k == "sample" || k == "queue") {
        if (!op_i64(op, "now", &now, err) || !op_i64(op, k == "sample" ? "slack" : "level", &v, err)) return false;
        if (k == "sample") s->sample(now, v);
        else s->queue_level(now, v);
    } else if (k == "starve") {
        if (!op_i64(op, "now", &now, err) || !op_flag(op, "on", &flag, err)) return false;
        s->starve(now, flag);
    } else if (k == "late") {
        if (!op_i64(op, "now", &now, err) || !op_i64(op, "by", &v, err)) return false;
        s->late(now, v);
    } else if (k == "clear") {
        if (!op_i64(op, "now", &now, err)) return false;
        s->clear(now);
    } else if (k == "break") {
        s->epoch_break();
    } else if (k == "group") {
        if (!op_i64(op, "now", &now, err) || !op_i64(op, "target", &v, err)) return false;
        s->set_group(now, v);
    } else if (k == "update") {
        if (!op_i64(op, "now", &now, err) || !op_i64(op, "render", &v, err) || !op_flag(op, "can", &flag, err))
            return false;
        s->update(now, v, flag);
        for (const DrainEvent& e : s->take_events())
            std::printf("{\"event\":\"%s\",\"at\":%lld,\"value\":%lld}\n", drain_event_name(e.kind), (long long)e.at,
                        (long long)e.value);
        std::printf("{\"ppb\":%lld,\"excess\":%lld,\"margin\":%lld,\"learned\":%lld,\"trough\":%lld,\"target\":%lld,"
                    "\"drained\":%lld,\"raises\":%llu,\"underruns\":%llu,\"outages\":%llu,\"state\":\"%s\","
                    "\"capped\":%d}\n",
                    (long long)s->ppb(), (long long)s->excess(), (long long)s->margin(),
                    (long long)(s->has_learned() ? s->learned() : -1), (long long)s->trough(), (long long)s->target(),
                    (long long)s->drained(), (unsigned long long)s->raises(), (unsigned long long)s->underruns(),
                    (unsigned long long)s->outages(), drain_state_name(s->state()), s->capped() ? 1 : 0);
    } else {
        return *err = "unknown op \"" + k + "\"", false;
    }
    return true;
}

int drain_main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: mrts_cli drain seq.jsonl|-\n");
        return 2;
    }
    const std::string path = argv[1];
    std::FILE* f = path == "-" ? stdin : std::fopen(path.c_str(), "rb");
    if (!f) {
        std::perror(argv[1]);
        return 1;
    }
    static char out[1 << 16];
    std::setvbuf(stdout, out, _IOFBF, sizeof out);
    DrainServo servo;
    std::string line, err;
    char buf[1 << 16];
    size_t lineno = 0;
    int rc = 0;
    while (rc == 0) {
        line.clear();
        bool got = false;
        while (std::fgets(buf, sizeof buf, f)) {
            got = true;
            line += buf;
            if (!line.empty() && line.back() == '\n') break;
        }
        if (!got) break;
        lineno++;
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        Json op;
        if (!parse_json(line, &op, &err) || !drain_op(op, &servo, &err)) {
            std::fflush(stdout);
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", argv[1], lineno, err.c_str());
            rc = 1;
        }
    }
    if (f != stdin) std::fclose(f);
    return rc;
}

// --- egress: a recording through mrts::EgressCore, py/egress_core.py's replay (WI-P5-2) ----

const char kEgressUsage[] =
    "usage: mrts_cli egress in.ts --clock case.clock.json [--bus in.bus.jsonl] [--chunk N]\n"
    "                          [--out out.ts] [--expect case.expect.jsonl]\n"
    "  Replays a recording through mrts::EgressCore as py/egress_core.py's CLI does (the parity\n"
    "  verb, B-222): the clock file's declaration, lateness ramp, changes and config; buffers of\n"
    "  N bytes (default the file's \"chunk\", else 1316) or the sidecar's, a GAP one as a marker.\n"
    "  Prints the events, each program's stats, the counters and the output's length, CRC-32 and\n"
    "  SHA-256 as JSON lines (sorted keys); --expect compares them instead, exit 1 on a difference.\n";

// python's int() of a JSON value: an integer, a float truncated, a decimal string, a bool.
bool py_int(const Json& j, int64_t* v) {
    if (j.type == Json::Type::boolean) return *v = j.b ? 1 : 0, true;
    if (j.type == Json::Type::string) return parse_int(j.s, v);
    if (j.i64(v)) return true;
    double d;
    if (!j.f64(&d) || !(d > -9.2e18 && d < 9.2e18)) return false;
    *v = (int64_t)d;
    return true;
}

bool py_bool(const Json& j, bool* v) {
    if (j.type == Json::Type::boolean) return *v = j.b, true;
    int64_t x;
    if (!py_int(j, &x)) return false;
    *v = x != 0;
    return true;
}

bool clock_from_json(const Json& j, ClockDecl* c, std::string* err) {
    if (j.type != Json::Type::object) return *err = "a clock is not an object", false;
    for (const auto& kv : j.keys) {
        const std::string& k = kv.first;
        const Json& v = kv.second;
        int64_t x = 0;
        bool ok = true;
        if (k == "eNs") ok = py_int(v, &c->e_ns);
        else if (k == "seq") ok = py_int(v, &c->seq);
        else if (k == "known") ok = py_bool(v, &c->known);
        else if (k == "traceable") ok = py_bool(v, &c->traceable);
        else if (k == "disciplined") ok = py_bool(v, &c->disciplined);
        else if (k == "source") ok = py_int(v, &x) && x >= 0 && x <= 255, c->source = (uint8_t)x;
        else if (k == "taiOffsetS") ok = py_int(v, &c->tai_offset_s);
        else if (k == "ptpDomain") ok = py_int(v, &x) && x >= INT32_MIN && x <= INT32_MAX, c->ptp_domain = (int)x;
        else if (k == "errorUs") {
            if (v.type == Json::Type::null) c->error_us.reset();
            else ok = py_int(v, &x), c->error_us = x;
        } else if (k == "gm") {
            uint64_t gm = 0;
            if (v.type == Json::Type::null) c->gm.reset();
            else if (v.type == Json::Type::string && hcdesc::parse_gm(v.s, &gm)) c->gm = gm;
            else c->gm.reset();               // python's parse_gm: None
        } else if (k == "timelineId") {
            ok = v.type == Json::Type::string && hcdesc::parse_timeline_text(v.s, &c->timeline_id);
        }
        if (!ok) return *err = "bad clock \"" + k + "\"", false;
    }
    return true;
}

// The content clock (py/egress_core.py content_anchors): (byte offset, house ns) of the first
// PCR PID's PCRs, unwrapped, - 1 h; with no PCR the first timing PID's DTS, else PTS.
std::vector<std::pair<int64_t, int64_t>> content_anchors(const uint8_t* d, size_t n) {
    std::vector<std::pair<size_t, const uint8_t*>> pkts;
    for (size_t off = 0; off + PKT <= n;) {
        if (d[off] != SYNC_BYTE) {
            off++;
            continue;
        }
        pkts.emplace_back(off, d + off);
        off += PKT;
    }
    const int64_t hour = 3600LL * 1000000000LL;
    std::vector<std::pair<int64_t, int64_t>> out;
    int pcr_pid = -1;
    for (const auto& op : pkts)
        if (read_pcr(op.second) >= 0) {
            pcr_pid = ts_pid(op.second);
            break;
        }
    int64_t last = 0, u = 0;
    bool have = false;
    if (pcr_pid >= 0) {
        for (const auto& op : pkts) {
            if (ts_pid(op.second) != pcr_pid) continue;
            const int64_t v = read_pcr(op.second);
            if (v < 0) continue;
            if (!have) {
                u = v;
            } else {
                int64_t dd = ((v - last) % PCR_MODULO + PCR_MODULO) % PCR_MODULO;
                u += dd > PCR_MODULO / 2 ? dd - PCR_MODULO : dd;
            }
            last = v;
            have = true;
            out.emplace_back((int64_t)op.first, pcr27_to_ns(u) - hour);
        }
        return out;
    }
    int tpid = -1;
    for (const auto& op : pkts) {
        uint8_t b[PKT];
        std::memcpy(b, op.second, PKT);
        PacketView v;
        parse_packet(b, &v);
        if (!v.pusi || v.payload_off >= PKT) continue;
        PesHeader h;
        if (!parse_pes_header(b + v.payload_off, PKT - v.payload_off, &h) || !h.complete || h.pts < 0) continue;
        if (!((h.sid & 0xF0) == 0xE0 || (h.sid & 0xE0) == 0xC0)) continue;
        if (tpid < 0) tpid = v.pid;
        if (v.pid != tpid) continue;
        const int64_t t = h.dts >= 0 ? h.dts : h.pts;
        u = have ? u + fold33(t - last) : t;
        last = t;
        have = true;
        out.emplace_back((int64_t)op.first, pts90k_to_ns(u) - hour);
    }
    return out;
}

// Linear between (x, y) points sorted by x, floor division, held outside them.
int64_t interp(const std::vector<std::pair<int64_t, int64_t>>& pts, int64_t x) {
    if (pts.empty()) return 0;
    const size_t k = (size_t)(std::upper_bound(pts.begin(), pts.end(), x,
                                               [](int64_t a, const std::pair<int64_t, int64_t>& p) {
                                                   return a < p.first;
                                               }) - pts.begin());
    if (k == 0) return pts[0].second;
    if (k == pts.size()) return pts.back().second;
    const auto& a = pts[k - 1];
    const auto& b = pts[k];
    if (b.first == a.first) return b.second;
    const __int128 num = (__int128)(b.second - a.second) * (x - a.first);
    const __int128 den = b.first - a.first;
    __int128 q = num / den;
    if (num % den != 0 && ((num < 0) != (den < 0))) q -= 1;
    return a.second + (int64_t)q;
}

// SHA-256 (FIPS 180-4), for the replay's output line.
std::string sha256_hex(const uint8_t* d, size_t n) {
    static const uint32_t K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    auto rotr = [](uint32_t x, int r) { return (x >> r) | (x << (32 - r)); };
    std::vector<uint8_t> m(d, d + n);
    m.push_back(0x80);
    while (m.size() % 64 != 56) m.push_back(0);
    for (int i = 7; i >= 0; i--) m.push_back((uint8_t)(((uint64_t)n * 8) >> (8 * i)));
    for (size_t at = 0; at < m.size(); at += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; i++)
            w[i] = (uint32_t)m[at + 4 * i] << 24 | (uint32_t)m[at + 4 * i + 1] << 16 | (uint32_t)m[at + 4 * i + 2] << 8 |
                   m[at + 4 * i + 3];
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], dd = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; i++) {
            const uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
            const uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g, g = f, f = e, e = dd + t1, dd = c, c = b, b = a, a = t1 + t2;
        }
        h[0] += a, h[1] += b, h[2] += c, h[3] += dd, h[4] += e, h[5] += f, h[6] += g, h[7] += hh;
    }
    char out[65];
    for (int i = 0; i < 8; i++) std::snprintf(out + 8 * i, 9, "%08x", h[i]);
    return std::string(out, 64);
}

// One JSON object of the replay's lines, its keys sorted as python's sort_keys.
std::string sorted_obj(const std::map<std::string, std::string>& kv) {
    std::string s = "{";
    for (const auto& p : kv) s += (s.size() > 1 ? "," : "") + jstr(p.first) + ":" + p.second;
    return s + "}";
}

std::string egress_event_json(const EgressEvent& e) {
    using K = EgressEvent::Kind;
    auto n = [](int64_t v) { return std::to_string(v); };
    std::map<std::string, std::string> kv = {{"event", jstr(egress_event_name(e.kind))},
                                             {"packet", std::to_string(e.packet)}};
    switch (e.kind) {
        case K::d_e_lower:
            kv["gapNs"] = n(e.gap_ns);
            [[fallthrough]];
        case K::d_e_start: case K::d_e_raise: case K::d_e_max:
            kv["program"] = n(e.program);
            kv["fromNs"] = n(e.from_ns);
            kv["toNs"] = n(e.to_ns);
            kv["latenessNs"] = n(e.lateness_ns);
            break;
        case K::re_epoch:
            kv["seq"] = n(e.seq);
            kv["fromSeq"] = n(e.from_seq);
            kv["deltaNs"] = n(e.delta_ns);
            break;
        case K::pcr_pid_assigned:
            kv["program"] = n(e.program);
            kv["pid"] = n(e.pid);
            break;
        case K::pmt_grew:
            kv["program"] = n(e.program);
            kv["inPackets"] = n(e.in_packets);
            kv["outPackets"] = n(e.out_packets);
            break;
        case K::cc_lost_in:
            kv["pid"] = n(e.pid);
            break;
    }
    return sorted_obj(kv);
}

std::string egress_stats_json(const EgressStats& s) {
    auto n = [](int64_t v) { return std::to_string(v); };
    auto u = [](uint64_t v) { return std::to_string(v); };
    return "{\"stats\":" + sorted_obj({{"pesRewritten", u(s.pes_rewritten)}, {"pcrWritten", u(s.pcr_written)},
                                       {"pcrInserted", u(s.pcr_inserted)}, {"pmtSent", u(s.pmt_sent)},
                                       {"latenessNs", s.lateness_ns ? n(*s.lateness_ns) : "null"},
                                       {"latenessMaxNs", n(s.lateness_max_ns)},
                                       {"pcrIntervalMaxNs", n(s.pcr_interval_max_ns)}, {"program", n(s.program)},
                                       {"dENs", n(s.d_e_ns)}, {"dEChanges", u(s.d_e_changes)},
                                       {"latenessOffHouse", u(s.lateness_off_house)},
                                       {"pmtVersion", n(s.pmt_version)}, {"pcrPid", n(s.pcr_pid)}}) +
           "}";
}

std::string egress_counters_json(const EgressCounters& c) {
    auto u = [](uint64_t v) { return std::to_string(v); };
    return "{\"counters\":" + sorted_obj({{"ccLostIn", u(c.cc_lost_in)}, {"droppedBeforePmt", u(c.dropped_before_pmt)},
                                          {"gapMarkers", u(c.gap_markers)}, {"gaps", u(c.gaps)},
                                          {"held", u(c.held)}, {"reEpochs", u(c.re_epochs)}}) +
           "}";
}

struct EgressChange {
    bool integer = true;
    int64_t at_ns = 0;
    double at_ms = 0;
    const Json* clock = nullptr;
};

int egress_main(int argc, char** argv) {
    std::string in, clock_path, bus_in, out_path, expect;
    int64_t chunk = 0;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        const bool arg = i + 1 < argc;
        if (a == "--clock" && arg) clock_path = argv[++i];
        else if (a == "--bus" && arg) bus_in = argv[++i];
        else if (a == "--out" && arg) out_path = argv[++i];
        else if (a == "--expect" && arg) expect = argv[++i];
        else if (a == "--chunk" && arg && parse_int(argv[i + 1], &chunk) && chunk >= 1) i++;
        else if (a[0] != '-' && in.empty()) in = a;
        else return std::fputs(kEgressUsage, stderr), 2;
    }
    if (in.empty() || clock_path.empty()) return std::fputs(kEgressUsage, stderr), 2;
    std::string ts, spec_text, err;
    if (!read_file(in, &ts)) return std::perror(in.c_str()), 1;
    Json spec;
    if (!read_file(clock_path, &spec_text) || !parse_json(spec_text, &spec, &err) || spec.type != Json::Type::object) {
        std::fprintf(stderr, "mrts_cli: %s: %s\n", clock_path.c_str(), err.empty() ? "not a clock file" : err.c_str());
        return 2;
    }
    const int64_t MS = 1000000;
    EgressConfig cfg;
    if (const Json* c = spec.get("config")) {
        const std::pair<const char*, int64_t*> keys[] = {
            {"pcrIntervalMs", &cfg.pcr_interval_ns}, {"marginMs", &cfg.margin_ns}, {"headroomMs", &cfg.headroom_ns},
            {"floorMs", &cfg.floor_ns}, {"maxMs", &cfg.max_ns}, {"gapLowerMinMs", &cfg.gap_lower_min_ns}};
        for (const auto& k : keys) {
            if (const Json* v = c->get(k.first)) {
                int64_t x;
                if (!py_int(*v, &x)) return std::fprintf(stderr, "mrts_cli: bad config %s\n", k.first), 2;
                *k.second = x * MS;
            }
        }
    }
    ClockDecl clock;
    if (const Json* c = spec.get("clock"))
        if (!clock_from_json(*c, &clock, &err)) return std::fprintf(stderr, "mrts_cli: %s\n", err.c_str()), 2;
    std::vector<std::pair<int64_t, int64_t>> lat;
    if (const Json* l = spec.get("lateness")) {
        for (const Json& p : l->items) {
            int64_t t, ms;
            if (p.items.size() != 2 || !py_int(p.items[0], &t) || !py_int(p.items[1], &ms))
                return std::fputs("mrts_cli: bad lateness\n", stderr), 2;
            lat.emplace_back(t * MS, ms * MS);
        }
    } else {
        lat.emplace_back(0, 0);
    }
    std::vector<EgressChange> changes;
    if (const Json* ch = spec.get("changes")) {
        for (const Json& c : ch->items) {
            EgressChange e;
            const Json* at = c.get("atMs");
            if (!at || at->type != Json::Type::number) return std::fputs("mrts_cli: bad change\n", stderr), 2;
            e.integer = at->i64(&e.at_ns);
            if (e.integer) e.at_ns *= MS;
            else at->f64(&e.at_ms);
            e.clock = c.get("clock");
            changes.push_back(e);
        }
        std::stable_sort(changes.begin(), changes.end(), [](const EgressChange& a, const EgressChange& b) {
            const double x = a.integer ? (double)a.at_ns / 1e6 : a.at_ms, y = b.integer ? (double)b.at_ns / 1e6 : b.at_ms;
            return x < y;
        });
    }
    const uint8_t* d = reinterpret_cast<const uint8_t*>(ts.data());
    const size_t size = ts.size();
    std::vector<BusLine> bus;
    if (!bus_in.empty() && !read_bus(bus_in, in, size, &bus)) return 1;
    if (chunk == 0) {
        chunk = 1316;
        if (const Json* c = spec.get("chunk"))
            if (!py_int(*c, &chunk) || chunk < 1) return std::fputs("mrts_cli: bad chunk\n", stderr), 2;
    }
    const std::vector<std::pair<int64_t, int64_t>> anchors = content_anchors(d, size);
    const int64_t c0 = anchors.empty() ? 0 : anchors[0].second;
    auto content = [&](int64_t off) { return interp(anchors, off); };
    auto now_at = [&](int64_t off) {
        const int64_t c = content(off);
        return c + interp(lat, c - c0);
    };
    struct Clk : ClockReader {
        std::function<int64_t(int64_t)> f;
        int64_t off = 0;
        int64_t read(size_t i) const override { return f(off + (int64_t)i * PKT); }
    } clk;
    clk.f = now_at;
    EgressCore core(cfg);
    core.set_clock(clock);
    std::vector<uint8_t> out;
    std::vector<std::string> lines;
    auto take = [&]() {
        for (const EgressEvent& e : core.take_events()) lines.push_back(egress_event_json(e));
    };
    auto step = [&](int64_t off, int64_t len, bool gap, int64_t gap_pts) {
        size_t k = 0;
        for (; k < changes.size(); k++) {
            const EgressChange& c = changes[k];
            const int64_t dc = content(off) - c0;
            if (!(c.integer ? dc >= c.at_ns : (double)dc >= c.at_ms * 1e6)) break;
            if (c.clock && !clock_from_json(*c.clock, &clock, &err)) return false;
            core.set_clock(clock);
        }
        changes.erase(changes.begin(), changes.begin() + k);
        clk.off = off;
        const EgressResult& r = gap ? core.on_gap(d + off, (size_t)len, now_at(off), gap_pts, clk)
                                    : core.process(d + off, (size_t)len, now_at(off), clk);
        r.apply(out);
        take();
        return true;
    };
    bool ok = true;
    if (!bus_in.empty()) {
        for (const BusLine& b : bus)
            ok = ok && step((int64_t)b.off, (int64_t)b.len, (b.flags & 2048) && b.pts >= 0, b.pts);
    } else {
        for (int64_t o = 0; ok && o < (int64_t)size; o += chunk) ok = step(o, std::min<int64_t>(chunk, size - o), false, 0);
    }
    if (!ok) return std::fprintf(stderr, "mrts_cli: %s\n", err.c_str()), 2;
    core.flush(out);
    for (int n : core.programs()) {
        EgressStats s;
        core.stats(n, &s);
        lines.push_back(egress_stats_json(s));
    }
    lines.push_back(egress_counters_json(core.counters()));
    char crc[9];
    std::snprintf(crc, sizeof crc, "%08x", crc32_zlib(out.data(), out.size()));
    lines.push_back("{\"output\":" + sorted_obj({{"bytes", std::to_string(out.size())}, {"crc32", jstr(crc)},
                                                {"sha256", jstr(sha256_hex(out.data(), out.size()))}}) +
                    "}");
    if (!out_path.empty() && !write_bytes(out_path, reinterpret_cast<const char*>(out.data()), out.size())) {
        std::perror(out_path.c_str());
        return 1;
    }
    if (!expect.empty()) {
        std::string text;
        if (!read_file(expect, &text)) return std::perror(expect.c_str()), 1;
        std::vector<std::string> want;
        for (size_t at = 0; at < text.size();) {
            size_t nl = text.find('\n', at);
            if (nl == std::string::npos) nl = text.size();
            const std::string l = text.substr(at, nl - at);
            at = nl + 1;
            if (l.find_first_not_of(" \t\r") != std::string::npos) want.push_back(l);
        }
        if (want == lines) return 0;
        for (size_t k = 0; k < std::max(want.size(), lines.size()); k++) {
            const std::string x = k < want.size() ? want[k] : "", y = k < lines.size() ? lines[k] : "";
            if (x != y) {
                std::fprintf(stderr, "line %zu:\n  want %s\n  got  %s\n", k + 1, x.c_str(), y.c_str());
                break;
            }
        }
        return 1;
    }
    std::string text;
    for (const std::string& l : lines) text += l + "\n";
    std::fwrite(text.data(), 1, text.size(), stdout);
    return 0;
}


// --- pcrcheck and hcdesc: a wire capture measured (WI-P5-5, B-223) ---------------------

// The PAT and every PMT it names, sections reassembled per PID and CRC-checked; a
// section a CC loss cuts is dropped, counted.
class PsiSections {
  public:
    struct Section {
        int pid;
        const std::vector<uint8_t>& bytes;   // table_id to CRC
        bool crc_ok;
    };
    using Sink = std::function<void(const Section&)>;
    explicit PsiSections(Sink sink) : sink_(std::move(sink)) {}

    void watch(int pid) { open_[pid]; }
    bool watched(int pid) const { return open_.count(pid) != 0; }
    void packet(const PacketView& v, CcTracker::Result cc) {
        auto it = open_.find(v.pid);
        if (it == open_.end() || cc == CcTracker::Result::Duplicate) return;
        Buf& b = it->second;
        if (cc == CcTracker::Result::Lost && b.open) cut(b);
        if (v.payload_off >= PKT) return;
        const uint8_t* p = v.p + v.payload_off;
        int n = PKT - v.payload_off;
        if (!v.pusi) {
            if (b.open) append(v.pid, b, p, n);
            return;
        }
        const int ptr = p[0];
        if (1 + ptr > n) {
            if (b.open) cut(b);
            return;
        }
        if (b.open) {
            append(v.pid, b, p + 1, ptr);
            if (b.open) cut(b);
        }
        p += 1 + ptr;
        n -= 1 + ptr;
        while (n > 0 && p[0] != 0xFF) {     // back-to-back sections after the pointer
            b.bytes.assign(p, p + n);
            b.open = true;
            const int len = need(b);          // 0: under 3 bytes, kept open for the next packet
            if (len <= 0 || len > n) {
                if (len < 0) cut(b);
                return;
            }
            emit(v.pid, b, len);
            p += len;
            n -= len;
        }
    }
    uint64_t cut_sections() const { return cut_; }

  private:
    struct Buf {
        std::vector<uint8_t> bytes;
        bool open = false;
    };
    // The section's whole length once its header is in; -1 = not a PSI section.
    static int need(const Buf& b) {
        if (b.bytes.size() < 3) return 0;
        const int len = 3 + (((b.bytes[1] & 0x0F) << 8) | b.bytes[2]);
        return len > 4096 || len < 3 + 9 ? -1 : len;
    }
    void append(int pid, Buf& b, const uint8_t* p, int n) {
        b.bytes.insert(b.bytes.end(), p, p + n);
        const int len = need(b);
        if (len < 0) cut(b);
        else if (len > 0 && (int)b.bytes.size() >= len) emit(pid, b, len);
    }
    void emit(int pid, Buf& b, int len) {
        b.bytes.resize((size_t)len);
        b.open = false;
        sink_(Section{pid, b.bytes, crc32_mpeg(b.bytes.data(), b.bytes.size()) == 0});
    }
    void cut(Buf& b) {
        b.open = false;
        b.bytes.clear();
        cut_++;
    }
    Sink sink_;
    std::map<int, Buf> open_;
    uint64_t cut_ = 0;
};

// A PAT section's {program_number, pmt_pid}, program 0 (the NIT) left out.
std::vector<std::pair<int, int>> pat_programs(const std::vector<uint8_t>& s) {
    std::vector<std::pair<int, int>> out;
    if (s[0] != TABLE_PAT || !(s[5] & 0x01)) return out;
    for (size_t i = 8; i + 4 + 4 <= s.size(); i += 4) {
        const int prog = (s[i] << 8) | s[i + 1], pid = ((s[i + 2] & 0x1F) << 8) | s[i + 3];
        if (prog != 0) out.emplace_back(prog, pid);
    }
    return out;
}

// A PMT section, CRC already checked; false when it is not one, or overruns itself.
bool pmt_from_section(const std::vector<uint8_t>& s, Pmt* m) {
    if (s[0] != TABLE_PMT || !(s[5] & 0x01) || s.size() < 16) return false;
    m->program_number = (s[3] << 8) | s[4];
    m->version = (s[5] >> 1) & 0x1F;
    m->pcr_pid = ((s[8] & 0x1F) << 8) | s[9];
    const size_t end = s.size() - 4, pil = (size_t)(((s[10] & 0x0F) << 8) | s[11]);
    if (12 + pil > end) return false;
    m->program_info.assign(s.begin() + 12, s.begin() + 12 + (long)pil);
    m->streams.clear();
    for (size_t i = 12 + pil; i + 5 <= end;) {
        PmtStream st;
        st.stream_type = s[i];
        st.pid = ((s[i + 1] & 0x1F) << 8) | s[i + 2];
        const size_t eil = (size_t)(((s[i + 3] & 0x0F) << 8) | s[i + 4]);
        if (i + 5 + eil > end) return false;
        st.es_info.assign(s.begin() + (long)(i + 5), s.begin() + (long)(i + 5 + eil));
        m->streams.push_back(std::move(st));
        i += 5 + eil;
    }
    return true;
}

// One input file walked packet by packet with the CC check and the PSI sections; the
// PAT's PMT PIDs are watched as it names them.
class TsWalk {
  public:
    // `program`: the PMT's own, else (a bad section) the PAT's for its PID; -1 when neither.
    using OnPmt = std::function<void(int pmt_pid, int program, bool crc_ok, const Pmt* pmt)>;
    using OnPacket = std::function<void(const PacketView&, CcTracker::Result)>;
    TsWalk(OnPmt on_pmt, OnPacket on_packet)
        : on_pmt_(std::move(on_pmt)), on_packet_(std::move(on_packet)),
          psi_([this](const PsiSections::Section& s) { section(s); }) {
        psi_.watch(PID_PAT);
    }
    // 0 read, 1 an I/O error (said on stderr).
    int run(const std::string& path) {
        FILE* f = std::fopen(path.c_str(), "rb");
        if (!f) return std::perror(path.c_str()), 1;
        std::vector<uint8_t> buf(1316 * 16);
        size_t n;
        while ((n = std::fread(buf.data(), 1, buf.size(), f)) > 0)
            walker_.feed(buf.data(), n, [&](PacketView& v) {
                const CcTracker::Result cc = v.pid == PID_NULL ? CcTracker::Result::Ok : cc_.feed(v);
                if (cc == CcTracker::Result::Lost) cc_errors_[v.pid]++;
                psi_.packet(v, cc);
                on_packet_(v, cc);
                packets_++;
            });
        const bool failed = std::ferror(f);
        std::fclose(f);
        if (failed) return std::perror(path.c_str()), 1;
        return 0;
    }
    uint64_t packets() const { return packets_; }     // the index of the packet being handed out
    uint64_t desync_bytes() const { return walker_.desync_bytes(); }
    uint64_t pat_sections() const { return pat_sections_; }
    uint64_t pat_crc_errors() const { return pat_crc_errors_; }
    uint64_t cut_sections() const { return psi_.cut_sections(); }
    const std::map<int, uint64_t>& cc_errors() const { return cc_errors_; }

  private:
    void section(const PsiSections::Section& s) {
        if (s.pid == PID_PAT) {
            pat_sections_++;
            if (!s.crc_ok) {
                pat_crc_errors_++;
                return;
            }
            for (const auto& pp : pat_programs(s.bytes)) {
                if (!psi_.watched(pp.second)) psi_.watch(pp.second);
                pmt_program_.emplace(pp.second, pp.first);
            }
            return;
        }
        if (s.bytes[0] != TABLE_PMT) return;
        Pmt m;
        if (s.crc_ok && pmt_from_section(s.bytes, &m)) return on_pmt_(s.pid, m.program_number, true, &m);
        const auto it = pmt_program_.find(s.pid);
        on_pmt_(s.pid, it == pmt_program_.end() ? -1 : it->second, s.crc_ok, nullptr);
    }
    OnPmt on_pmt_;
    OnPacket on_packet_;
    PsiSections psi_;
    PacketWalker walker_;
    CcTracker cc_;
    std::map<int, uint64_t> cc_errors_;
    std::map<int, int> pmt_program_;      // PMT PID -> the PAT's first program on it
    uint64_t packets_ = 0, pat_sections_ = 0, pat_crc_errors_ = 0;
};

// A 27 MHz difference folded to (-PCR_MODULO/2, PCR_MODULO/2], in ns.
int64_t fold_pcr_ns(int64_t d27) {
    d27 %= PCR_MODULO;
    if (d27 > PCR_MODULO / 2) d27 -= PCR_MODULO;
    if (d27 <= -PCR_MODULO / 2) d27 += PCR_MODULO;
    return d27 * 1000 / 27;
}

const char kPcrcheckUsage[] =
    "usage: mrts_cli pcrcheck in.ts [--arrival in.stct]\n"
    "  The PCR and timestamp checks of TR 101 290 on a capture, per program as JSON lines (WI-P5-5):\n"
    "  PCR intervals (a histogram by upper bound in ms, the max; over 40 ms a repetition error),\n"
    "  PCR jumps (negative or over 100 ms) with and without discontinuity_indicator, per PID the\n"
    "  minimum PTS - PCR and DTS - PCR against the PCR in force (on a video or audio PES or the\n"
    "  PCR PID's, DTS else PTS at or below 0 is an error; on another, untimedBeforePcr counts\n"
    "  it), CC errors and PMT CRC errors. --arrival: per PCR PID of the trace, arrival -\n"
    "  PCR's peak to peak, raw and with the best line removed, per run between jumps. Exit 1 on\n"
    "  any violation (an unflagged jump, a repetition, a PES at or before the PCR, a CC or CRC\n"
    "  error, a program with PES and no PCR, no program at all). Exit 3 on an unreadable input or a\n"
    "  bad or truncated trace. jumpMaxNs: the largest unflagged jump, signed. driftPpb > 0: the\n"
    "  sender's PCR runs slow against arrival.\n";

constexpr int64_t PCR_JUMP_NS = 100 * 1000000LL;   // TR 101 290 PCR_discontinuity_indicator_error
constexpr int64_t HIST_MS[] = {10, 20, 30, 35, 40, 100};

struct PcrProgram {
    struct Pid {
        uint64_t pes = 0;
        bool timing = false;                  // a video or audio PES, or on the PCR PID (B-51)
        bool have_pts = false, have_dts = false;
        int64_t pts_min = 0, dts_min = 0;
        std::vector<uint8_t> held;            // a PES header split over packets
        int64_t held_pcr = -1;
    };
    int pmt_pid = -1, pcr_pid = PID_NULL;
    std::set<int> es;
    int64_t last_pcr = -1;
    uint64_t pcrs = 0, flagged = 0, repetition = 0, jumps = 0, jumps_flagged = 0;
    int64_t interval_max_ns = 0, jump_max_ns = 0;   // the largest unflagged jump by size, signed
    uint64_t hist[sizeof HIST_MS / sizeof HIST_MS[0]] = {};
    uint64_t pes = 0, unjudged = 0, before_pcr = 0, untimed_before_pcr = 0, cc = 0, pmt_sections = 0, pmt_crc = 0;
    std::map<int, Pid> pids;

    void pcr(int64_t v, bool disc) {
        pcrs++;
        if (disc) flagged++;
        if (last_pcr >= 0) {
            const int64_t d = fold_pcr_ns(v - last_pcr);
            const bool jump = d < 0 || d > PCR_JUMP_NS;   // 0..100 ms is in range
            if (disc) {
                if (jump) jumps_flagged++;
            } else if (jump) {
                if (!jumps || std::llabs(d) > std::llabs(jump_max_ns)) jump_max_ns = d;
                jumps++;
            } else {
                interval_max_ns = std::max(interval_max_ns, d);
                size_t k = 0;
                while (d > HIST_MS[k] * 1000000LL) k++;
                hist[k]++;
                if (d > PCR_MAX_INTERVAL_NS) repetition++;
            }
        }
        last_pcr = v;
    }
    // A PES header's bytes on `pid`, the PCR in force when it started; false = cut short.
    // Only a timing PES can be an error: D_e covers those (the writer's rule), a late private
    // stream (teletext, KLV) is its source's and is counted apart.
    bool judge(int pid, Pid& p, const uint8_t* b, size_t n, int64_t pcr_then) {
        PesHeader h;
        if (!parse_pes_header(b, n, &h)) return true;
        if (!h.complete) return false;
        if (h.pts < 0) return true;
        pes++;
        p.pes++;
        const bool timing = timing_sid(h.sid, pid, pcr_pid);
        p.timing = p.timing || timing;
        if (pcr_then < 0) {
            unjudged++;
            return true;
        }
        const int64_t dp = fold_pcr_ns(h.pts * 300 - pcr_then);
        p.pts_min = p.have_pts ? std::min(p.pts_min, dp) : dp;
        p.have_pts = true;
        int64_t check = dp;
        if (h.dts >= 0) {
            const int64_t dd = fold_pcr_ns(h.dts * 300 - pcr_then);
            p.dts_min = p.have_dts ? std::min(p.dts_min, dd) : dd;
            p.have_dts = true;
            check = dd;
        }
        if (check <= 0) (timing ? before_pcr : untimed_before_pcr)++;
        return true;
    }
    void payload(const PacketView& v) {
        Pid& p = pids[v.pid];
        const uint8_t* b = v.p + v.payload_off;
        const size_t n = (size_t)(PKT - v.payload_off);
        if (v.pusi) {
            p.held.clear();
            if (!judge(v.pid, p, b, n, last_pcr)) {
                p.held.assign(b, b + n);
                p.held_pcr = last_pcr;
            }
        } else if (!p.held.empty()) {
            p.held.insert(p.held.end(), b, b + n);
            if (judge(v.pid, p, p.held.data(), p.held.size(), p.held_pcr) || p.held.size() > 2 * PKT) p.held.clear();
        }
    }
    uint64_t violations() const {
        return repetition + jumps + before_pcr + cc + pmt_crc + (pcrs == 0 && pes > 0 ? 1 : 0);
    }
};

struct ArrivalRun {
    std::vector<std::pair<double, double>> xy;   // PCR s from the run's first, arrival - PCR ns
};

// Peak to peak of y, raw and less its least-squares line in x; the slope in ppb.
void line_fit(const ArrivalRun& r, double* raw, double* detrended, double* ppb) {
    double sx = 0, sy = 0, sxx = 0, sxy = 0, lo = 0, hi = 0;
    const double n = (double)r.xy.size();
    for (size_t i = 0; i < r.xy.size(); i++) {
        const double x = r.xy[i].first, y = r.xy[i].second;
        sx += x, sy += y, sxx += x * x, sxy += x * y;
        lo = i ? std::min(lo, y) : y;
        hi = i ? std::max(hi, y) : y;
    }
    *raw = hi - lo;
    const double den = n * sxx - sx * sx;
    const double b = den > 0 ? (n * sxy - sx * sy) / den : 0, a = (sy - b * sx) / n;
    lo = hi = 0;
    for (size_t i = 0; i < r.xy.size(); i++) {
        const double e = r.xy[i].second - (a + b * r.xy[i].first);
        lo = i ? std::min(lo, e) : e;
        hi = i ? std::max(hi, e) : e;
    }
    *detrended = hi - lo;
    *ppb = b;                                     // ns per s
}

std::string hist_json(const uint64_t* h) {
    std::string s = "{";
    for (size_t k = 0; k < sizeof HIST_MS / sizeof HIST_MS[0]; k++)
        s += (k ? ",\"" : "\"") + std::to_string(HIST_MS[k]) + "\":" + std::to_string(h[k]);
    return s + "}";
}

int pcrcheck_main(int argc, char** argv) {
    std::string in, arrival;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--arrival" && i + 1 < argc) arrival = argv[++i];
        else if (a[0] != '-' && in.empty()) in = a;
        else return std::fputs(kPcrcheckUsage, stderr), 2;
    }
    if (in.empty()) return std::fputs(kPcrcheckUsage, stderr), 2;
    std::map<int, PcrProgram> progs;             // by program_number
    std::map<int, std::set<int64_t>> pcr_values; // per PCR PID, for --arrival's match
    TsWalk walk(
        [&](int pmt_pid, int program, bool crc_ok, const Pmt* m) {
            if (program < 0) return;
            PcrProgram& p = progs[program];
            p.pmt_pid = pmt_pid;
            p.pmt_sections++;
            if (!crc_ok) p.pmt_crc++;
            if (!m) return;
            if (m->pcr_pid != p.pcr_pid) p.last_pcr = -1;   // a new PCR PID is not measured against the old
            p.pcr_pid = m->pcr_pid;
            p.es.clear();
            for (const PmtStream& st : m->streams) p.es.insert(st.pid);
        },
        [&](const PacketView& v, CcTracker::Result cc) {
            if (v.pid == PID_NULL || cc == CcTracker::Result::Duplicate) return;
            for (auto& kv : progs) {
                PcrProgram& p = kv.second;
                if (v.pid == p.pcr_pid && v.af_pcr) {
                    const int64_t pcr = read_pcr(v.p);
                    p.pcr(pcr, v.af_discontinuity);
                    if (!arrival.empty()) pcr_values[v.pid].insert(pcr);
                }
                if (!p.es.count(v.pid)) continue;
                if (cc == CcTracker::Result::Lost) {
                    p.cc++;
                    p.pids[v.pid].held.clear();   // a split header is not joined across a loss
                }
                if (v.payload_off < PKT) p.payload(v);
            }
        });
    if (walk.run(in)) return 3;
    // An empty or PAT-less capture is no clean one.
    uint64_t violations = walk.pat_crc_errors() + (progs.empty() ? 1 : 0), cc_total = 0, cc_outside = 0;
    for (const auto& kv : walk.cc_errors()) {
        cc_total += kv.second;
        bool listed = false;
        for (const auto& pk : progs) listed = listed || pk.second.es.count(kv.first);
        if (!listed) cc_outside += kv.second;
    }
    violations += cc_outside;
    for (const auto& kv : progs) {
        const PcrProgram& p = kv.second;
        std::string s = "{\"pcrcheck\":\"program\",\"program\":" + std::to_string(kv.first) +
                        ",\"pmtPid\":" + std::to_string(p.pmt_pid) + ",\"pcrPid\":" + std::to_string(p.pcr_pid) +
                        ",\"pcrs\":" + std::to_string(p.pcrs) + ",\"pcrFlagged\":" + std::to_string(p.flagged) +
                        ",\"intervalMaxNs\":" + std::to_string(p.interval_max_ns) +
                        ",\"intervalHistMs\":" + hist_json(p.hist) +
                        ",\"pcrRepetitionErrors\":" + std::to_string(p.repetition) +
                        ",\"pcrJumpsUnflagged\":" + std::to_string(p.jumps) +
                        ",\"pcrJumpsFlagged\":" + std::to_string(p.jumps_flagged) +
                        ",\"jumpMaxNs\":" + (p.jumps ? std::to_string(p.jump_max_ns) : std::string("null")) +
                        ",\"pes\":" + std::to_string(p.pes) + ",\"pesUnjudged\":" + std::to_string(p.unjudged) +
                        ",\"pesBeforePcr\":" + std::to_string(p.before_pcr) +
                        ",\"untimedBeforePcr\":" + std::to_string(p.untimed_before_pcr) +
                        ",\"ccErrors\":" + std::to_string(p.cc) +
                        ",\"pmtSections\":" + std::to_string(p.pmt_sections) +
                        ",\"pmtCrcErrors\":" + std::to_string(p.pmt_crc) + ",\"pids\":[";
        bool first = true;
        for (const auto& pp : p.pids) {
            if (!pp.second.pes) continue;
            s += std::string(first ? "" : ",") + "{\"pid\":" + std::to_string(pp.first) +
                 ",\"timing\":" + (pp.second.timing ? "true" : "false") +
                 ",\"pes\":" + std::to_string(pp.second.pes) + ",\"ptsMinusPcrMinNs\":" +
                 (pp.second.have_pts ? std::to_string(pp.second.pts_min) : "null") + ",\"dtsMinusPcrMinNs\":" +
                 (pp.second.have_dts ? std::to_string(pp.second.dts_min) : "null") + "}";
            first = false;
        }
        s += "],\"violations\":" + std::to_string(p.violations()) + "}";
        std::printf("%s\n", s.c_str());
        violations += p.violations();
    }
    if (!arrival.empty()) {
        TraceReader r;
        if (!r.open(arrival)) return std::fprintf(stderr, "mrts_cli: %s: not an arrival trace\n", arrival.c_str()), 3;
        struct Pid {
            uint64_t pcrs = 0, matched = 0;
            int64_t last = -1, first_arrival = 0, unwrapped = 0;
            std::vector<ArrivalRun> runs;
        };
        std::map<int, Pid> by_pid;
        TraceRecord rec;
        while (r.next(&rec)) {
            if (rec.kind != TraceKind::pcr) continue;
            Pid& p = by_pid[rec.pid];
            const int64_t v = (int64_t)rec.value;
            p.pcrs++;
            auto pv = pcr_values.find(rec.pid);
            if (pv != pcr_values.end() && pv->second.count(v)) p.matched++;
            const int64_t d = p.last < 0 ? 0 : fold_pcr_ns(v - p.last);
            if (p.last < 0 || (rec.flags & TRACE_FLAG_DISCONTINUITY) || d < 0 || d > PCR_JUMP_NS) {
                p.runs.emplace_back();
                p.unwrapped = 0;
                p.first_arrival = rec.arrival_ns;
            } else {
                p.unwrapped += d;
            }
            p.last = v;
            p.runs.back().xy.emplace_back((double)p.unwrapped / 1e9,
                                          (double)(rec.arrival_ns - p.first_arrival - p.unwrapped));
        }
        if (r.status() == TraceReader::Status::truncated || r.status() == TraceReader::Status::bad_header)
            return std::fprintf(stderr, "mrts_cli: %s: truncated\n", arrival.c_str()), 3;
        for (const auto& kv : by_pid) {
            const Pid& p = kv.second;
            double raw = 0, det = 0, ppb = 0;
            size_t longest = 0;
            for (size_t k = 0; k < p.runs.size(); k++) {
                double a, b, c;
                line_fit(p.runs[k], &a, &b, &c);
                raw = std::max(raw, a);
                det = std::max(det, b);
                if (p.runs[k].xy.size() > p.runs[longest].xy.size()) longest = k;
            }
            if (!p.runs.empty()) {
                double a, b;
                line_fit(p.runs[longest], &a, &b, &ppb);
            }
            std::printf("{\"pcrcheck\":\"arrival\",\"pid\":%d,\"pcrs\":%llu,\"matched\":%llu,\"runs\":%zu,"
                        "\"jitterPpNs\":%.0f,\"detrendedPpNs\":%.0f,\"driftPpb\":%.0f}\n",
                        kv.first, (unsigned long long)p.pcrs, (unsigned long long)p.matched, p.runs.size(), raw, det,
                        ppb);
        }
    }
    std::printf("{\"pcrcheck\":\"summary\",\"packets\":%llu,\"desyncBytes\":%llu,\"programs\":%zu,"
                "\"patSections\":%llu,\"patCrcErrors\":%llu,\"sectionsCut\":%llu,\"ccErrors\":%llu,"
                "\"violations\":%llu}\n",
                (unsigned long long)walk.packets(), (unsigned long long)walk.desync_bytes(), progs.size(),
                (unsigned long long)walk.pat_sections(), (unsigned long long)walk.pat_crc_errors(),
                (unsigned long long)walk.cut_sections(), (unsigned long long)cc_total,
                (unsigned long long)violations);
    return violations ? 1 : 0;
}

const char kHcdescUsage[] =
    "usage: mrts_cli hcdesc in.ts\n"
    "  Every house-time descriptor (MRHT, B-219) of every program, with its PMT's version, as\n"
    "  JSON lines: one line per PMT that differs from its program's last (version or descriptors),\n"
    "  \"mrht\" null without one, then a summary of the PMT sections seen (WI-P5-5).\n"
    "  Exit 3 on an unreadable input.\n";

std::string mrht_json(const HouseTimeDecl& d) {
    auto b = [](bool x) { return x ? "true" : "false"; };
    char s[640];
    std::snprintf(s, sizeof s,
                  "{\"hcVersion\":%u,\"houseTimeTai\":%s,\"disciplined\":%s,\"traceable\":%s,\"ptpValid\":%s,"
                  "\"syncSource\":%u,\"taiUtcOffsetS\":%u,\"ptpDomain\":%u,\"clockErrorClass\":%u,"
                  "\"gmIdentity\":\"%s\",\"epochSeq\":%u,\"dE90k\":%u,\"dENs\":%lld,\"timelineId\":\"%s\"}",
                  d.version, b(d.house_time_tai), b(d.disciplined), b(d.traceable), b(d.ptp_valid), d.sync_source,
                  d.tai_utc_offset_s, d.ptp_domain, d.clock_error_class, hcdesc::gm_text(d.gm_identity).c_str(),
                  d.epoch_seq, d.d_e_90k, (long long)pts90k_to_ns(d.d_e_90k),
                  hcdesc::timeline_text(d.timeline_id).c_str());
    return s;
}

int hcdesc_main(int argc, char** argv) {
    std::string in;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a[0] != '-' && in.empty()) in = a;
        else return std::fputs(kHcdescUsage, stderr), 2;
    }
    if (in.empty()) return std::fputs(kHcdescUsage, stderr), 2;
    struct Last {
        int version = -1;
        std::vector<uint8_t> info;
    };
    std::map<int, Last> last;                    // by program_number
    uint64_t sections = 0, crc_errors = 0, printed = 0, with_mrht = 0;
    TsWalk* self = nullptr;
    TsWalk walk(
        [&](int pmt_pid, int, bool crc_ok, const Pmt* m) {
            sections++;
            if (!crc_ok) crc_errors++;
            if (!m) return;
            HouseTimeDecl d;
            const bool found = hcdesc::find_in(m->program_info, &d);
            if (found) with_mrht++;
            Last& l = last[m->program_number];
            if (l.version == m->version && l.info == m->program_info) return;
            l.version = m->version;
            l.info = m->program_info;
            bool undecodable = false;
            for_each_descriptor(m->program_info.data(), (int)m->program_info.size(), [&](const Descriptor& x) {
                if (x.tag == hcdesc::TAG && x.len >= 4 &&
                    ((uint32_t)x.data[0] << 24 | (uint32_t)x.data[1] << 16 | (uint32_t)x.data[2] << 8 | x.data[3]) ==
                        hcdesc::FORMAT)
                    undecodable = undecodable || !found;
            });
            std::printf("{\"hcdesc\":\"pmt\",\"packet\":%llu,\"program\":%d,\"pmtPid\":%d,\"version\":%d,\"mrht\":%s%s}\n",
                        (unsigned long long)self->packets(), m->program_number, pmt_pid, m->version,
                        found ? mrht_json(d).c_str() : "null", undecodable ? ",\"undecodable\":true" : "");
            printed++;
        },
        [](const PacketView&, CcTracker::Result) {});
    self = &walk;
    if (walk.run(in)) return 3;
    std::printf("{\"hcdesc\":\"summary\",\"pmtSections\":%llu,\"pmtCrcErrors\":%llu,\"withMrht\":%llu,\"lines\":%llu}\n",
                (unsigned long long)sections, (unsigned long long)crc_errors, (unsigned long long)with_mrht,
                (unsigned long long)printed);
    return 0;
}

// --- trust-replay: TrustGate over the reference's event list (p5-6b, parity with py/trust_gate.py) ---

const char kTrustUsage[] =
    "usage: mrts_cli trust-replay events.jsonl|- [--pes]\n"
    "  py/trust_gate.py's event list through one TrustGate per program, its output byte for byte:\n"
    "  each transition, with --pes each PES's mapping, then a summary per program.\n";

std::string jnum_or_null(bool have, int64_t v) { return have ? std::to_string((long long)v) : "null"; }
std::string jstr_or_null(const char* s) { return s ? jstr(s) : "null"; }

std::string transition_json(int program, const TrustGate::Transition& t) {
    std::string s = "{\"t\":" + std::to_string((long long)t.t) + ",\"program\":" + std::to_string(program) +
                    ",\"decision\":\"" + trust_decision_name(t.decision) + "\",\"from\":\"" +
                    trust_state_name(t.from) + "\",\"state\":\"" + trust_state_name(t.state) +
                    "\",\"failed\":" + jstr_or_null(t.failed);
    if (t.has_k) s += ",\"kNs\":" + std::to_string((long long)t.k_ns) + ",\"k90k\":" + std::to_string((long long)t.k90k);
    if (t.has_gap) s += ",\"gapNs\":" + std::to_string((long long)t.gap_ns);
    return s + "}";
}

std::string trust_stats_json(int program, const TrustGate::Stats& s) {
    char b[32];
    std::snprintf(b, sizeof b, "%08x", s.digest);
    std::string o = "{\"program\":" + std::to_string(program) + ",\"state\":\"" + trust_state_name(s.state) +
                    "\",\"mode\":\"" + (s.trust_selected ? "trust" : "restamp") + "\",\"failed\":" +
                    jstr_or_null(s.failed) + ",\"switches\":" + std::to_string((unsigned long long)s.switches) +
                    ",\"pes\":{\"stc\":" + std::to_string((unsigned long long)s.pes[0]) +
                    ",\"restamp\":" + std::to_string((unsigned long long)s.pes[1]) +
                    ",\"trust\":" + std::to_string((unsigned long long)s.pes[2]) +
                    ",\"converging\":" + std::to_string((unsigned long long)s.pes[3]) + "},\"digest\":\"" + b +
                    "\",\"transit\":";
    o += s.have_transit ? "{\"minNs\":" + std::to_string((long long)s.transit_min_ns) + ",\"medianNs\":" +
                              std::to_string((long long)s.transit_median_ns) + ",\"maxNs\":" +
                              std::to_string((long long)s.transit_max_ns) + "}"
                        : std::string("null");
    o += ",\"boundLoNs\":" + std::to_string((long long)s.bound_lo_ns) + ",\"boundHiNs\":" +
         std::to_string((long long)s.bound_hi_ns) + ",\"kNs\":" + std::to_string((long long)s.k_ns);
    o += ",\"timelineId\":" + (s.have_decl ? jstr(hcdesc::timeline_text(s.decl.timeline_id)) : std::string("null"));
    o += ",\"deNs\":" + jnum_or_null(s.have_decl, pts90k_to_ns(s.decl.d_e_90k));
    o += ",\"epochSeq\":" + jnum_or_null(s.have_decl, s.decl.epoch_seq) + "}";
    return o;
}

// The reference's Replay: gates in the order first seen, a step of every gate after every event.
class TrustReplay {
  public:
    explicit TrustReplay(bool pes_rows) : pes_rows_(pes_rows) {}
    bool feed(const Json& ev, std::string* err);
    void finish() {
        std::vector<size_t> order(gates_.size());
        for (size_t i = 0; i < order.size(); i++) order[i] = i;
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return gates_[a].program < gates_[b].program; });
        for (size_t i : order) std::printf("%s\n", trust_stats_json(gates_[i].program, gates_[i].gate->stats(now_)).c_str());
    }

  private:
    struct Held {
        int pid;
        int64_t pts, dmp, stc, now;
    };
    struct Entry {
        int program;
        std::unique_ptr<TrustGate> gate;
        std::vector<Held> held;
    };
    Entry& gate(int program, int64_t now) {
        for (Entry& e : gates_)
            if (e.program == program) return e;
        gates_.push_back(Entry{program, std::make_unique<TrustGate>(program, cfg_, clock_, trust_, now), {}});
        return gates_.back();
    }
    Entry* find(int program) {
        for (Entry& e : gates_)
            if (e.program == program) return &e;
        return nullptr;
    }
    // A PES out through the gate: STC states add O and the trim in restamp (the reference's stand-in).
    std::string emit(Entry& e, const Held& h) {
        TrustGate& g = *e.gate;
        int64_t stc = h.stc;
        if (stc >= 0 && g.state() == TrustGate::State::restamp) {
            const auto it = trims_.find(h.pid);
            stc += ns_to_pts90k(offset_ + (it == trims_.end() ? 0 : it->second));
        }
        const TrustGate::Mapped m = g.map(h.pts, h.dmp, stc);
        g.emitted(h.pid, h.pts, m, h.now);
        return "{\"t\":" + std::to_string((long long)h.now) + ",\"program\":" + std::to_string(e.program) +
               ",\"pid\":" + std::to_string(h.pid) + ",\"mapping\":\"" + trust_mapping_name(m.kind) + "\",\"pts\":" +
               jnum_or_null(m.pts >= 0, m.pts) + ",\"dts\":" + jnum_or_null(m.dts >= 0, m.dts) +
               ",\"k90k\":" + std::to_string((long long)m.k90k) + "}";
    }
    void release_if(Entry& e, bool was_deciding, std::vector<std::string>* rows) {
        if (!was_deciding || e.gate->state() == TrustGate::State::deciding) return;
        std::vector<Held> q;
        q.swap(e.held);
        for (const Held& h : q) rows->push_back(emit(e, h));
    }

    TrustConfig cfg_;
    ClockDecl clock_;
    bool trust_ = false;
    int64_t offset_ = 0;
    std::map<int, int64_t> trims_;
    std::vector<Entry> gates_;
    std::vector<std::pair<int, int>> pid_program_, pcr_pid_;   // dicts in insertion order
    bool pes_rows_;
    int64_t now_ = 0;
};

bool get_i64(const Json& ev, const char* key, int64_t* v, std::string* err) {
    const Json* j = ev.get(key);
    if (!j || !j->i64(v)) return *err = std::string("missing or bad \"") + key + "\"", false;
    return true;
}

bool get_bool(const Json& ev, const char* key, bool* v, std::string* err) {
    const Json* j = ev.get(key);
    if (!j || j->type != Json::Type::boolean) return *err = std::string("missing or bad \"") + key + "\"", false;
    *v = j->b;
    return true;
}

// A decl line (trace2jsonl's) as the gate's declaration; false when absent.
bool decl_of(const Json& ev, HouseTimeDecl* d, bool* present, std::string* err) {
    if (!get_bool(ev, "present", present, err)) return false;
    if (!*present) return true;
    int64_t de = 0, cls = 0, seq = 0;
    const Json* tl = ev.get("timelineId");
    if (!get_bool(ev, "houseTimeTai", &d->house_time_tai, err) || !get_bool(ev, "disciplined", &d->disciplined, err) ||
        !get_i64(ev, "de90k", &de, err) || !get_i64(ev, "clockErrorClass", &cls, err) ||
        !get_i64(ev, "epochSeq", &seq, err))
        return false;
    if (!tl || tl->type != Json::Type::string || !hcdesc::parse_timeline_text(tl->s, &d->timeline_id))
        return *err = "missing or bad \"timelineId\"", false;
    d->d_e_90k = (uint32_t)de;
    d->clock_error_class = (uint8_t)cls;
    d->epoch_seq = (uint16_t)seq;
    return true;
}

bool TrustReplay::feed(const Json& ev, std::string* err) {
    const Json* kj = ev.get("kind");
    if (!kj || kj->type != Json::Type::string) return *err = "missing \"kind\"", false;
    const std::string& k = kj->s;
    if (k == "config") {
        struct Key {
            const char* name;
            int64_t TrustConfig::*i64;
            int TrustConfig::*i;
        };
        static const Key keys[] = {
            {"negBaseNs", &TrustConfig::neg_base_ns, nullptr}, {"badPcrs", nullptr, &TrustConfig::bad_pcrs},
            {"decidePcrs", nullptr, &TrustConfig::decide_pcrs}, {"decideMaxNs", &TrustConfig::decide_max_ns, nullptr},
            {"qualifyNs", &TrustConfig::qualify_ns, nullptr},
            {"returnQualifiedNs", &TrustConfig::return_qualified_ns, nullptr},
            {"returnGapWaitNs", &TrustConfig::return_gap_wait_ns, nullptr},
            {"pmtStaleNs", &TrustConfig::pmt_stale_ns, nullptr}};
        for (const auto& kv : ev.keys) {
            if (kv.first == "kind") continue;
            const Key* hit = nullptr;
            for (const Key& x : keys)
                if (kv.first == x.name) hit = &x;
            int64_t v = 0;
            if (!hit) return *err = "unknown config key " + kv.first, false;
            if (!kv.second.i64(&v)) return *err = "bad value for " + kv.first, false;
            if (hit->i64) cfg_.*(hit->i64) = v;
            else cfg_.*(hit->i) = (int)v;
        }
        for (Entry& e : gates_) {
            TrustConfig c = cfg_;
            c.l_ns = e.gate->config().l_ns;
            c.tau_ns = e.gate->config().tau_ns;
            e.gate->set_config(c);
        }
        return true;
    }
    int64_t now = 0;
    if (!get_i64(ev, "t", &now, err)) return false;
    now_ = now;
    std::vector<std::string> rows;
    std::vector<bool> deciding;
    auto snapshot = [&]() {
        deciding.clear();
        for (Entry& e : gates_) deciding.push_back(e.gate->state() == TrustGate::State::deciding);
    };
    if (k == "psi") {
        int64_t program = 0, pid = 0;
        bool pcr = false;
        if (!get_i64(ev, "program", &program, err) || !get_i64(ev, "pid", &pid, err) || !get_bool(ev, "pcrPid", &pcr, err))
            return false;
        Entry& e = gate((int)program, now);
        if (pcr) {
            pid_program_.erase(std::remove_if(pid_program_.begin(), pid_program_.end(),
                                              [&](const std::pair<int, int>& x) { return x.second == e.program; }),
                               pid_program_.end());
            bool found = false;
            for (auto& x : pcr_pid_)
                if (x.first == e.program) x.second = (int)pid, found = true;
            if (!found) pcr_pid_.push_back({e.program, (int)pid});
        } else {
            bool found = false;
            for (auto& x : pid_program_)
                if (x.first == (int)pid) x.second = e.program, found = true;
            if (!found) pid_program_.push_back({(int)pid, e.program});
        }
        e.gate->pmt_seen(now);
    } else if (k == "decl") {
        int64_t program = 0;
        HouseTimeDecl d;
        bool present = false;
        if (!get_i64(ev, "program", &program, err) || !decl_of(ev, &d, &present, err)) return false;
        gate((int)program, now).gate->on_pmt(present ? &d : nullptr, now);
    } else if (k == "pcr") {
        int64_t pid = 0, pcr = 0;
        if (!get_i64(ev, "pid", &pid, err) || !get_i64(ev, "pcr", &pcr, err)) return false;
        for (const auto& x : pcr_pid_)
            if (x.second == (int)pid) find(x.first)->gate->on_pcr(pcr, now);
    } else if (k == "pes") {
        int64_t pid = 0, pts = 0, dmp = 0, stc = -1;
        if (!get_i64(ev, "pid", &pid, err) || !get_i64(ev, "pts", &pts, err)) return false;
        if (const Json* j = ev.get("dtsMinusPts"))
            if (!j->i64(&dmp)) return *err = "bad \"dtsMinusPts\"", false;
        if (const Json* j = ev.get("stc"))
            if (j->type != Json::Type::null && !j->i64(&stc)) return *err = "bad \"stc\"", false;
        for (const auto& x : pid_program_) {
            if (x.first != (int)pid) continue;
            Entry& e = *find(x.second);
            const Held h{(int)pid, pts, dmp, stc, now};
            if (e.gate->state() == TrustGate::State::deciding) e.held.push_back(h);
            else rows.push_back(emit(e, h));
        }
    } else if (k == "outage" || k == "natural-gap") {
        int64_t g_ns = 0, program = 0;
        if (!get_i64(ev, k == "outage" ? "silenceNs" : "gapNs", &g_ns, err)) return false;
        const Json* pj = k == "natural-gap" ? ev.get("program") : nullptr;
        if (pj && !pj->i64(&program)) return *err = "bad \"program\"", false;
        for (Entry& e : gates_)
            if (!pj || program == e.program) e.gate->on_natural_gap(g_ns, now);
    } else if (k == "mode") {
        const Json* m = ev.get("mode");
        if (!m || m->type != Json::Type::string) return *err = "missing \"mode\"", false;
        trust_ = m->s == "trust";
        snapshot();
        for (size_t i = 0; i < gates_.size(); i++) {
            gates_[i].gate->set_mode(trust_, now);
            release_if(gates_[i], deciding[i], &rows);
        }
    } else if (k == "l" || k == "tau") {
        int64_t ns = 0;
        if (!get_i64(ev, "ns", &ns, err)) return false;
        (k == "l" ? cfg_.l_ns : cfg_.tau_ns) = ns;
        for (Entry& e : gates_) {
            e.gate->set_l(cfg_.l_ns);
            e.gate->set_tau(cfg_.tau_ns);
        }
    } else if (k == "clock") {
        ClockDecl c;
        int64_t seq = 0, error_us = 0;
        if (!get_i64(ev, "eNs", &c.e_ns, err) || !get_bool(ev, "disciplined", &c.disciplined, err)) return false;
        if (const Json* j = ev.get("seq"))
            if (!j->i64(&seq)) return *err = "bad \"seq\"", false;
        c.seq = seq;
        if (const Json* j = ev.get("errorUs"); j && j->type != Json::Type::null) {
            if (!j->i64(&error_us)) return *err = "bad \"errorUs\"", false;
            c.error_us = error_us;
        }
        clock_ = c;
        for (Entry& e : gates_) e.gate->set_clock(clock_, now);
    } else if (k == "offset") {
        if (!get_i64(ev, "ns", &offset_, err)) return false;
    } else if (k == "trim") {
        int64_t pid = 0, ns = 0;
        if (!get_i64(ev, "pid", &pid, err) || !get_i64(ev, "ns", &ns, err)) return false;
        trims_[(int)pid] = ns;
    } else if (k != "tick" && k != "decl2") {
        return *err = "unknown event kind " + k, false;
    }
    snapshot();
    for (size_t i = 0; i < gates_.size(); i++) {
        gates_[i].gate->step(now);
        release_if(gates_[i], deciding[i], &rows);
    }
    for (Entry& e : gates_)
        for (const TrustGate::Transition& t : e.gate->take_log())
            std::printf("%s\n", transition_json(e.program, t).c_str());
    if (pes_rows_)
        for (const std::string& r : rows) std::printf("%s\n", r.c_str());
    return true;
}

int trust_replay_main(int argc, char** argv) {
    std::string input;
    bool pes = false;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--pes") pes = true;
        else if ((a == "-" || a[0] != '-') && input.empty()) input = a;
        else return std::fputs(kTrustUsage, stderr), 2;
    }
    if (input.empty()) return std::fputs(kTrustUsage, stderr), 2;
    std::string text;
    if (!read_file(input, &text)) {
        std::fprintf(stderr, "mrts_cli: cannot read %s\n", input.c_str());
        return 1;
    }
    TrustReplay r(pes);
    size_t at = 0, line = 0;
    while (at < text.size()) {
        size_t nl = text.find('\n', at);
        if (nl == std::string::npos) nl = text.size();
        const std::string s = text.substr(at, nl - at);
        at = nl + 1;
        line++;
        if (s.find_first_not_of(" \t\r") == std::string::npos) continue;
        Json ev;
        std::string err;
        if (!parse_json(s, &ev, &err) || ev.type != Json::Type::object || !r.feed(ev, &err)) {
            std::fflush(stdout);
            std::fprintf(stderr, "mrts_cli: %s:%zu: %s\n", input.c_str(), line, err.empty() ? "not an object" : err.c_str());
            return 1;
        }
    }
    r.finish();
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::strcmp(argv[1], "dump") == 0) return dump_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "trace2jsonl") == 0) return trace2jsonl_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "jsonl2trace") == 0) return jsonl2trace_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "restamp-replay") == 0) return restamp_replay_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "rebase") == 0) return rebase_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "demux") == 0) return demux_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "asrc") == 0) return asrc_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "pace") == 0) return pace_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "asrc-device") == 0) return asrc_device_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "drain") == 0) return drain_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "egress") == 0) return egress_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "pcrcheck") == 0) return pcrcheck_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "hcdesc") == 0) return hcdesc_main(argc - 1, argv + 1);
    if (argc > 1 && std::strcmp(argv[1], "trust-replay") == 0) return trust_replay_main(argc - 1, argv + 1);
    std::fprintf(stderr,
                 "usage: mrts_cli dump [--chunk N] [--program N] [--net E_ns] input.ts\n"
                 "       mrts_cli trace2jsonl input.stct\n"
                 "       mrts_cli jsonl2trace input.jsonl|- output.stct\n"
                 "       mrts_cli restamp-replay input.stct [--config k=v...] [--sweep grid.json] "
                 "[--expect file] ...\n"
                 "       mrts_cli rebase in.ts out.ts --to-ns T [--bus in.bus.jsonl out.bus.jsonl]\n"
                 "       mrts_cli demux in.ts [--chunk N] [--media M] [--select CAPS] [--program P] "
                 "[--house-ns T] [--bus in.bus.jsonl]\n"
                 "       mrts_cli asrc seq.txt|-\n"
                 "       mrts_cli pace seq.jsonl|-\n"
                 "       mrts_cli asrc-device seq.jsonl|-\n"
                 "       mrts_cli drain seq.jsonl|-\n"
                 "       mrts_cli egress in.ts --clock case.clock.json [--bus B] [--chunk N] [--out O] "
                 "[--expect E]\n"
                 "       mrts_cli pcrcheck in.ts [--arrival in.stct]\n"
                 "       mrts_cli hcdesc in.ts\n"
                 "       mrts_cli trust-replay events.jsonl|- [--pes]\n");
    return 2;
}
