// ts_trace: the .stct arrival-trace format (WI-P1-2). The record layout pinned byte
// for byte, write -> read -> write byte-identical, and the reader on unclosed,
// truncated and foreign files. Files go to a fresh directory under $TMPDIR.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <unistd.h>

#include "../ts_trace.h"
#include "check.h"

using namespace mrts;

namespace {

using Bytes = std::vector<uint8_t>;

std::string g_dir;
std::vector<std::string> g_files;

std::string path(const char* name) {
    const std::string p = g_dir + "/" + name;
    g_files.push_back(p);
    return p;
}

Bytes slurp(const std::string& p) {
    Bytes b;
    std::FILE* f = std::fopen(p.c_str(), "rb");
    if (!f) return b;
    uint8_t buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) b.insert(b.end(), buf, buf + n);
    std::fclose(f);
    return b;
}

void spit(const std::string& p, const Bytes& b) {
    std::FILE* f = std::fopen(p.c_str(), "wb");
    if (!f) return;
    std::fwrite(b.data(), 1, b.size(), f);
    std::fclose(f);
}

// Every kind, the extremes of every field, negative DTS deltas.
std::vector<TraceRecord> sample() {
    std::vector<TraceRecord> v;
    uint64_t s = 12345;
    auto rnd = [&]() {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return s >> 11;
    };
    for (int i = 0; i < 1000; i++) {
        TraceRecord r;
        r.arrival_ns = 100000000000LL + i * 7000000LL + (int64_t)(rnd() % 3000000);
        r.kind = (TraceKind)(1 + i % 4);
        r.pid = (uint16_t)(0x100 + i % 5);
        r.flags = trace_flags(i % 7 == 0, (StreamClass)(i % 3));
        r.value = r.kind == TraceKind::pcr ? rnd() % (300ULL << 33) : rnd() % (1ULL << 33);
        r.dts_minus_pts_90k = r.kind == TraceKind::pes && i % 3 == 0 ? -(int32_t)(rnd() % 270000) : 0;
        v.push_back(r);
    }
    TraceRecord e;
    e.arrival_ns = INT64_MAX;
    e.value = UINT64_MAX;
    e.pid = 0xFFFF;
    e.kind = TraceKind::outage;
    e.flags = 0xFF;
    e.dts_minus_pts_90k = INT32_MIN;
    v.push_back(e);
    e.arrival_ns = INT64_MIN;
    e.value = 0;
    e.pid = 0;
    e.dts_minus_pts_90k = INT32_MAX;
    v.push_back(e);
    return v;
}

bool write_all(const std::string& p, const std::vector<TraceRecord>& v) {
    TraceWriter w;
    if (!w.open(p)) return false;
    for (const TraceRecord& r : v) w.write(r);
    return w.count() == v.size() && w.close();
}

struct Read {
    bool opened = false;
    std::vector<TraceRecord> v;
    TraceReader::Status status = TraceReader::Status::bad_header;
    uint64_t header_count = 0;
};

Read read_all(const std::string& p) {
    Read out;
    TraceReader rd;
    out.opened = rd.open(p);
    TraceRecord r;
    while (rd.next(&r)) out.v.push_back(r);
    out.status = rd.status();
    out.header_count = rd.header_count();
    return out;
}

void test_layout() {
    TraceRecord r;
    r.arrival_ns = 0x0102030405060708LL;
    r.value = 0x1112131415161718ULL;
    r.pid = 0x1FFF;
    r.kind = TraceKind::pes;
    r.flags = trace_flags(true, StreamClass::audio);
    r.dts_minus_pts_90k = -3600;
    uint8_t b[TRACE_RECORD_BYTES];
    encode_trace_record(r, b);
    const uint8_t want[TRACE_RECORD_BYTES] = {0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
                                              0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11,
                                              0xFF, 0x1F, 0x02, 0x05, 0xF0, 0xF1, 0xFF, 0xFF};
    CHECK("layout: a record is 24 bytes, little-endian, in the WI-P1-2 field order",
          std::memcmp(b, want, sizeof want) == 0);
    CHECK("layout: decode inverts encode", decode_trace_record(b) == r);
    uint8_t h[TRACE_HEADER_BYTES];
    encode_trace_header(42, h);
    const uint8_t hwant[TRACE_HEADER_BYTES] = {'S', 'T', 'C', 'T', 1, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0};
    CHECK("layout: header = \"STCT\", u32 version 1, u64 count", std::memcmp(h, hwant, sizeof hwant) == 0);
    CHECK("layout: flags carry the discontinuity bit and the class",
          r.flags == 0x05 && trace_class(r.flags) == StreamClass::audio &&
              trace_class(trace_flags(false, StreamClass::video)) == StreamClass::video &&
              (trace_flags(false, StreamClass::video) & TRACE_FLAG_DISCONTINUITY) == 0);
    CHECK("layout: PSI value packs program, stream type and the PCR mark",
          trace_psi_value(1, 0x1B, false) == 0x1B0001ULL && trace_psi_value(0x1234, 0, true) == (0x1234ULL | TRACE_PSI_PCR));
}

void test_round_trip() {
    const std::vector<TraceRecord> v = sample();
    const std::string a = path("a.stct"), b = path("b.stct");
    CHECK("round trip: the writer writes and closes", write_all(a, v));
    const Bytes fa = slurp(a);
    CHECK("round trip: 16 + 24 bytes per record", fa.size() == TRACE_HEADER_BYTES + TRACE_RECORD_BYTES * v.size());
    const Read r = read_all(a);
    bool same = r.v.size() == v.size();
    for (size_t i = 0; same && i < v.size(); i++) same = r.v[i] == v[i];
    CHECK("round trip: read back record for record", r.opened && same);
    CHECK("round trip: status ok, header count patched on close",
          r.status == TraceReader::Status::ok && r.header_count == v.size());
    CHECK("round trip: write -> read -> write is byte-identical", write_all(b, r.v) && slurp(b) == fa);

    // A writer dropped without close() still patches its count.
    const std::string c = path("c.stct");
    {
        TraceWriter w;
        w.open(c);
        for (size_t i = 0; i < 10; i++) w.write(v[i]);
    }
    const Read rc = read_all(c);
    CHECK("round trip: the destructor closes and patches", rc.status == TraceReader::Status::ok && rc.v.size() == 10);

    const std::string e = path("empty.stct");
    const Read re = (write_all(e, {}), read_all(e));
    CHECK("round trip: an empty closed trace reads as ok, no records",
          re.opened && re.v.empty() && re.status == TraceReader::Status::ok);
    CHECK("round trip: a writer on an unwritable path fails to open", !TraceWriter().open(g_dir + "/no/such/dir.stct"));
}

void test_damaged() {
    const std::vector<TraceRecord> v = sample();
    const std::string a = path("full.stct");
    write_all(a, v);
    const Bytes full = slurp(a);
    const std::string t = path("t.stct");
    auto with = [&](Bytes b) {
        spit(t, b);
        return read_all(t);
    };

    Read r = with(Bytes(full.begin(), full.begin() + 10));
    CHECK("damaged: a cut header does not open", !r.opened && r.status == TraceReader::Status::bad_header);
    Bytes bad = full;
    bad[0] = 'X';
    CHECK("damaged: a foreign magic does not open", !with(bad).opened);
    bad = full;
    bad[4] = 2;
    CHECK("damaged: version 2 does not open", !with(bad).opened);
    CHECK("damaged: a missing file does not open", !read_all(g_dir + "/missing.stct").opened);

    r = with(Bytes(full.begin(), full.begin() + TRACE_HEADER_BYTES + 5 * TRACE_RECORD_BYTES + 11));
    bool same = r.v.size() == 5;
    for (size_t i = 0; same && i < 5; i++) same = r.v[i] == v[i];
    CHECK("damaged: cut mid-record: the 5 whole records, then truncated",
          r.opened && same && r.status == TraceReader::Status::truncated);
    r = with(Bytes(full.begin(), full.begin() + TRACE_HEADER_BYTES + 5 * TRACE_RECORD_BYTES));
    CHECK("damaged: fewer records than the count: truncated", r.v.size() == 5 && r.status == TraceReader::Status::truncated);

    Bytes unclosed = full;
    std::memset(unclosed.data() + 8, 0, 8);   // what a writer that died leaves
    r = with(unclosed);
    same = r.v.size() == v.size();
    for (size_t i = 0; same && i < v.size(); i++) same = r.v[i] == v[i];
    CHECK("damaged: count 0 (never closed): every record, status unclosed",
          same && r.status == TraceReader::Status::unclosed && r.header_count == 0);
    unclosed.resize(unclosed.size() - 7);
    r = with(unclosed);
    CHECK("damaged: never closed and cut: the whole records, then truncated",
          r.v.size() == v.size() - 1 && r.status == TraceReader::Status::truncated);
}

}  // namespace

int main() {
    const char* tmp = std::getenv("TMPDIR");
    std::string tmpl = std::string(tmp && *tmp ? tmp : "/tmp") + "/ts_trace_test.XXXXXX";
    std::vector<char> buf(tmpl.begin(), tmpl.end());
    buf.push_back('\0');
    if (!mkdtemp(buf.data())) {
        std::printf("FAIL cannot create a temporary directory\n");
        return 1;
    }
    g_dir = buf.data();
    test_layout();
    test_round_trip();
    test_damaged();
    for (const std::string& f : g_files) std::remove(f.c_str());
    rmdir(g_dir.c_str());
    return test_summary("ts_trace");
}
