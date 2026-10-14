// ts_trace: the .stct arrival traces (WI-P1-2): the record layout byte for byte, the reader
// on damaged files, the player against an independently packetised source, the generator's
// determinism, and generated traces replayed to their epochs. Files go under $TMPDIR.
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <unistd.h>

#include "../ts_house.h"
#include "../ts_packet.h"
#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "../ts_psi.h"
#include "../ts_restamp.h"
#include "../ts_trace.h"
#include "check.h"
#include "trace_gen.h"

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

void test_memory_writer() {
    const std::vector<TraceRecord> v = sample();
    TraceWriter w;
    w.open_memory();
    for (const TraceRecord& r : v) w.write(r);
    const bool open = w.is_open();
    CHECK("memory: the records kept in order, counted, open until close",
          open && w.count() == v.size() && w.records() == v && w.close() && !w.is_open() && w.records() == v);
    const std::string p = path("after-memory.stct");
    CHECK("memory: a file open after it starts empty", w.open(p) && w.records().empty() && w.close() &&
                                                           read_all(p).v.empty());
}

// --- Replay: a trace played back as the TS its recorder read ------------------------

constexpr int64_t US = 1000, MS = 1000000, S = 1000000000;
using Ev = RestampCore::Event;

RestampConfig stc() { return RestampConfig(); }
int64_t iabs64(int64_t v) { return v < 0 ? -v : v; }

// Every kept PES of the restamp's output: (pts, dts) per PID in order.
struct OutLog {
    PacketWalker w;
    CcTracker cc;
    PesAssembler a;
    std::map<int, std::vector<std::pair<int64_t, int64_t>>> pes;
    std::vector<PesUnit> got;
    void select(int pid) { a.select(pid, true); }
    void feed(const RestampCore::Result& r) {
        Bytes b;
        for (const RestampCore::Range& k : r.keep) b.insert(b.end(), k.data, k.data + k.len);
        w.feed(b.data(), b.size(), [&](PacketView& v) { a.feed(v, cc.feed(v), got); });
        take();
    }
    void take() {
        for (const PesUnit& u : got) pes[u.pid].push_back({u.hdr.pts, u.hdr.dts});
        got.clear();
    }
    void end() {
        a.flush(got);
        take();
    }
};

struct Played {
    std::vector<TraceRecord> trace;       // what the core recorded
    std::vector<Ev> events;
    std::vector<int64_t> event_t;         // the arrival of the buffer each came in
    RestampCore::Stats stats;
    OutLog out;
    size_t buffers = 0;
    uint64_t misplaced = 0;
};

Played play(const std::vector<TraceRecord>& t, const std::vector<int>& pids, const RestampConfig& cfg = stc()) {
    Played p;
    RestampCore core(cfg);
    TraceWriter w;
    w.open_memory();
    core.set_trace(&w);
    for (int pid : pids) p.out.select(pid);
    TracePlayer pl(t, RestampCore::OUTAGE_NS);
    TracePlayer::Buffer b;
    while (pl.next(&b)) {
        p.buffers++;
        p.out.feed(core.process(b.bytes.data(), b.bytes.size(), b.arrival_ns));
        for (const Ev& e : core.take_events()) {
            p.events.push_back(e);
            p.event_t.push_back(b.arrival_ns);
        }
    }
    p.out.end();
    p.stats = core.stats();
    p.trace = w.records();
    p.misplaced = pl.misplaced();
    return p;
}

bool same_event(const Ev& a, const Ev& b) {
    return a.kind == b.kind && a.program == b.program && a.pid == b.pid && !std::strcmp(a.reason, b.reason) &&
           a.gap_ns == b.gap_ns && a.dropped_ns == b.dropped_ns && a.house_ns == b.house_ns && a.epoch == b.epoch &&
           a.value_ns == b.value_ns;
}

// An independent source, packetised as a muxer does (multi-packet PES, the PCR in video PES,
// PSI every 100 ms, 7-packet datagrams, split headers): a PMT change, the PCR moving, a flagged
// jump, a 3 s stall between a split header's packets ending in a burst, a 2 s loss outage.
constexpr int SP_V = 0x100, SP_A = 0x101, SP_O = 0x102, SP_T = 0x103, SP_A2 = 0x104, SP_PCR = 0x1FF,
              SP_PMT = 0x1000;

struct SrcPkt {
    uint8_t b[PKT];
    int64_t mux;
    bool held = false;                    // the first packet of a split header
};

void put_ts5(uint8_t* f, int prefix, int64_t v) {
    f[0] = (uint8_t)((prefix << 4) | (((v >> 30) & 0x07) << 1) | 1);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 1);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 1);
}

void add_pes(std::vector<SrcPkt>& out, int pid, uint8_t sid, int64_t pts, int64_t dts, size_t n, int64_t pcr,
             bool di, size_t first_cap, int64_t mux) {
    Bytes d = {0x00, 0x00, 0x01, sid, 0, 0, 0x84, (uint8_t)(dts >= 0 ? 0xC0 : 0x80), (uint8_t)(dts >= 0 ? 10 : 5)};
    uint8_t f[5];
    put_ts5(f, dts >= 0 ? 3 : 2, pts & ((1LL << 33) - 1));
    d.insert(d.end(), f, f + 5);
    if (dts >= 0) {
        put_ts5(f, 1, dts & ((1LL << 33) - 1));
        d.insert(d.end(), f, f + 5);
    }
    for (size_t i = 0; i < n; i++) d.push_back((uint8_t)(i * 7 + pid));
    d[4] = (uint8_t)((d.size() - 6) >> 8);
    d[5] = (uint8_t)(d.size() - 6);
    size_t at = 0;
    for (int k = 0; at < d.size(); k++) {
        SrcPkt p;
        std::memset(p.b, 0xFF, PKT);
        // A split header's continuation 3 ms on: other PIDs' packets come between.
        p.mux = mux + k * 50 * US + (first_cap && k > 0 ? 3 * MS : 0);
        p.b[0] = SYNC_BYTE;
        p.b[1] = (uint8_t)((k == 0 ? 0x40 : 0) | (pid >> 8));
        p.b[2] = (uint8_t)pid;
        p.b[3] = 0x10;
        size_t cap = k == 0 && first_cap ? first_cap : k == 0 && pcr >= 0 ? 176 : 184;
        if (k == 0 && di && !first_cap && pcr < 0) cap = 182;
        const size_t take = std::min(cap, d.size() - at);
        if (take < 184) {
            p.b[3] |= 0x20;
            p.b[4] = (uint8_t)(183 - take);
            if (take < 183) p.b[5] = 0x00;
            if (k == 0 && pcr >= 0) {
                p.b[5] = 0x10;
                write_pcr(p.b, pcr);
            }
            if (k == 0 && di) p.b[5] |= 0x80;
        }
        std::memcpy(p.b + PKT - take, d.data() + at, take);
        p.held = k == 0 && first_cap > 0;
        at += take;
        out.push_back(p);
    }
}

struct Dgram {
    Bytes b;
    int64_t arrival;
};

std::vector<Dgram> field_source(int64_t* stall_at) {
    const int64_t secs = 70 * S, jump_at = 30 * S, jump = 10 * S, pmt1_at = 20 * S, pcr_move_at = 40 * S;
    auto sigma90 = [&](int64_t t) { return ns_to_pts90k(7200 * S + t + (t >= jump_at ? jump : 0)); };
    auto pcr27 = [&](int64_t t) { return sigma90(t) * 300 + ns_to_pcr27(t) % 300; };
    std::vector<SrcPkt> pk;
    for (int64_t t = 5 * MS; t < secs; t += 100 * MS) {
        std::vector<PmtStream> es = {{SP_V, 0x1B, {}},
                                     {SP_A, 0x03, {}},
                                     {SP_O, 0x06, {0x05, 0x04, 'O', 'p', 'u', 's'}},
                                     {SP_T, 0x06, {0x56, 0x05, 'e', 'n', 'g', 0x09, 0x00}}};
        if (t >= pmt1_at) es.push_back({SP_A2, 0x0F, {}});
        SrcPkt a, m;
        build_pat(1, {{1, SP_PMT}}, 0, 0, a.b);
        build_pmt(SP_PMT, 1, t >= pcr_move_at ? SP_PCR : SP_V, es, 0, (t >= pmt1_at) + (t >= pcr_move_at), m.b);
        a.mux = m.mux = t;
        pk.push_back(a);
        pk.push_back(m);
    }
    int64_t last_pcr = -S;
    bool flag = true;
    for (int64_t k = 0; k * 40 * MS < secs; k++) {   // IPBB video, the PCR in its first packet
        const int64_t t = k * 40 * MS;
        const int64_t disp = k == 0 ? 0 : (k - 1) % 3 == 0 ? k + 2 : k - 1;
        const int64_t dts = sigma90(t) + 54000, pts = dts + (disp - k + 1) * 3600;
        const bool pcr_here = t < pcr_move_at && t - last_pcr >= 100 * MS;
        const bool di = pcr_here && flag && t >= jump_at;
        if (pcr_here) last_pcr = t;
        if (di) flag = false;
        add_pes(pk, SP_V, 0xE0, pts, pts == dts ? -1 : dts, 500 + (size_t)(k % 12 == 0) * 1500,
                pcr_here ? pcr27(t) : -1, di, 0, t);
    }
    for (int64_t t = pcr_move_at + 7 * MS; t < secs; t += 40 * MS) {
        SrcPkt p;
        build_pcr_packet(SP_PCR, pcr27(t), 0, p.b);
        p.mux = t;
        pk.push_back(p);
    }
    for (int64_t k = 0; k * 24 * MS < secs; k++) {
        const int64_t t = k * 24 * MS;
        add_pes(pk, SP_A, 0xC0, sigma90(t) + 36000, -1, 300, -1, false, k % 5 == 4 ? 10 : 0, t + 3 * MS);
    }
    for (int64_t t = 0; t < secs; t += 20 * MS)
        add_pes(pk, SP_O, 0xBD, sigma90(t) + 27000, -1, 120, -1, false, 0, t + 1 * MS);
    for (int64_t t = 0; t < secs; t += 40 * MS)
        add_pes(pk, SP_T, 0xBD, sigma90(t) + 54000, -1, 150, -1, false, 0, t + 2 * MS);
    for (int64_t k = 0; pmt1_at + k * 21333 * US < secs; k++) {
        const int64_t t = pmt1_at + k * 21333 * US;
        add_pes(pk, SP_A2, 0xC1, sigma90(t) + 40500, -1, 200, -1, false, 0, t + 4 * MS);
    }
    std::stable_sort(pk.begin(), pk.end(), [](const SrcPkt& a, const SrcPkt& b) { return a.mux < b.mux; });
    std::map<int, int> cc;
    for (SrcPkt& p : pk) {
        int& c = cc[ts_pid(p.b)];
        if (p.b[3] & 0x10) {
            p.b[3] = (uint8_t)((p.b[3] & 0xF0) | c);
            c = (c + 1) & 0x0F;
        } else {
            p.b[3] = (uint8_t)((p.b[3] & 0xF0) | ((c + 15) & 0x0F));
        }
    }
    // 7 packets a datagram; the stall begins after the first one past 50 s whose last
    // packet is a held header's first.
    std::vector<Dgram> dg;
    uint64_t lcg = 99;
    int64_t last = 0, stall_end = -1;
    *stall_at = -1;
    for (size_t i = 0; i < pk.size(); i += 7) {
        const size_t n = std::min<size_t>(7, pk.size() - i);
        if (pk[i].mux >= 62 * S && pk[i].mux < 64 * S) continue;   // lost
        Dgram d;
        for (size_t k = i; k < i + n; k++) d.b.insert(d.b.end(), pk[k].b, pk[k].b + PKT);
        lcg = lcg * 6364136223846793005ULL + 1442695040888963407ULL;
        const int64_t u = (int64_t)((lcg >> 33) % 1000);
        const int64_t send = pk[i + n - 1].mux;
        d.arrival = std::max(last, 100 * S + send + 20 * MS + 8 * MS * u / 1000 * u / 1000);
        if (stall_end >= 0) d.arrival = std::max(d.arrival, stall_end);
        if (*stall_at < 0 && send >= 50 * S && pk[i + n - 1].held) {
            *stall_at = d.arrival;
            stall_end = d.arrival + 3 * S;
        }
        last = d.arrival;
        dg.push_back(std::move(d));
    }
    return dg;
}

void test_player_fidelity() {
    int64_t stall_at = -1;
    const std::vector<Dgram> src = field_source(&stall_at);
    const std::vector<int> pids = {SP_V, SP_A, SP_O, SP_T, SP_A2};
    // The recording: the source through a RestampCore with the recorder on.
    RestampCore a(stc());
    TraceWriter w;
    w.open_memory();
    a.set_trace(&w);
    OutLog out_a;
    for (int pid : pids) out_a.select(pid);
    std::vector<Ev> ev_a;
    for (const Dgram& d : src) {
        Bytes b = d.b;
        out_a.feed(a.process(b.data(), b.size(), d.arrival));
        for (const Ev& e : a.take_events()) ev_a.push_back(e);
    }
    out_a.end();
    const RestampCore::Stats st_a = a.stats();
    const std::vector<TraceRecord> trace = w.records();
    int held = 0, outages = 0, tables = 0;
    for (size_t i = 0; i < trace.size(); i++) {
        held += i && trace[i].kind == TraceKind::pes && trace[i].arrival_ns < trace[i - 1].arrival_ns;
        outages += trace[i].kind == TraceKind::outage;
        tables += trace[i].kind == TraceKind::psi && (trace[i].value & TRACE_PSI_PCR);
    }
    // The replay.
    const Played b = play(trace, pids);
    bool same_events = ev_a.size() == b.events.size();
    for (size_t i = 0; same_events && i < ev_a.size(); i++) same_events = same_event(ev_a[i], b.events[i]);
    size_t n_pes = 0;
    for (const auto& kv : out_a.pes) n_pes += kv.second.size();
    int relocks = 0, overlaps = 0, outage_gaps = 0;
    for (const Ev& e : ev_a) {
        relocks += e.kind == Ev::Kind::relock;
        overlaps += e.kind == Ev::Kind::overlap;
        outage_gaps += e.kind == Ev::Kind::gap && !std::strcmp(e.reason, "outage");
    }
    std::printf("  field-like source: %zu datagrams, %zu records (%d tables, %d headers held across buffers, %d outages),"
                " %d relocks, %d overlaps, %d outage gaps, %zu PES out; replay %zu buffers\n",
                src.size(), trace.size(), tables, held, outages, relocks, overlaps, outage_gaps, n_pes, b.buffers);
    CHECK("player: the source holds headers across buffers, stalls, loses 2 s, changes its table twice, relocks 3 times",
          held >= 20 && outages == 2 && tables == 3 && relocks == 3 && overlaps >= 5 && outage_gaps >= 5 &&
              stall_at > 0 && st_a.header_spans > 500);
    CHECK("player: the replay records the trace it played, record for record", b.trace == trace && b.misplaced == 0);
    CHECK("player: the same events, every field (house-ns, epoch, gap and drop lengths, reasons)", same_events);
    CHECK("player: every kept PES leaves with the same PTS and DTS, PID by PID", b.out.pes == out_a.pes && n_pes > 10000);
    const RestampCore::ProgramStats& pa = st_a.programs[0];
    const RestampCore::ProgramStats& pb = b.stats.programs[0];
    CHECK("player: the same clock at the end (state, ppb, epoch, relocks, gaps, drops)",
          pa.clock.state == pb.clock.state && pa.clock.ppb == pb.clock.ppb && pa.clock.epoch == pb.clock.epoch &&
              pa.clock.relocks == pb.clock.relocks && pa.gaps == pb.gaps && pa.gap_ns_total == pb.gap_ns_total &&
              pa.dropped_pes == pb.dropped_pes && b.stats.header_spans == (uint64_t)held);

    // The comparison is not vacuous: the PCR 1 ms later from 10 s to 20 s (locked, one
    // epoch) moves the mapping, and the replay shows it.
    std::vector<TraceRecord> moved = trace;
    for (TraceRecord& r : moved)
        if (r.kind == TraceKind::pcr && r.arrival_ns >= 110 * S && r.arrival_ns < 120 * S)
            r.value = (r.value + 27000) % PCR_MODULO;
    const Played c = play(moved, pids);
    CHECK("player: a trace with the PCR 1 ms later for 10 s replays as such, and its output differs",
          c.trace == moved && !(c.out.pes == out_a.pes));
}

TraceRecord rec(int64_t t, TraceKind k, int pid, uint64_t v, uint8_t flags = 0, int32_t d = 0) {
    TraceRecord r;
    r.arrival_ns = t;
    r.kind = k;
    r.pid = (uint16_t)pid;
    r.value = v;
    r.flags = flags;
    r.dts_minus_pts_90k = d;
    return r;
}

// One program's table: PCR on 0x100 (video), audio on 0x101.
std::vector<TraceRecord> table(int64_t t, int program = 1, int v = 0x100, int a = 0x101) {
    return {rec(t, TraceKind::psi, v, trace_psi_value(program, 0, true)),
            rec(t, TraceKind::psi, v, trace_psi_value(program, 0x1B, false), trace_flags(false, StreamClass::video)),
            rec(t, TraceKind::psi, a, trace_psi_value(program, 0x03, false), trace_flags(false, StreamClass::audio))};
}

std::vector<TracePlayer::Buffer> buffers_of(const std::vector<TraceRecord>& t) {
    TracePlayer pl(t, RestampCore::OUTAGE_NS);
    std::vector<TracePlayer::Buffer> out;
    TracePlayer::Buffer b;
    while (pl.next(&b)) out.push_back(b);
    return out;
}

void test_player_cases() {
    const int64_t T = 1000 * S;
    const uint8_t V = trace_flags(false, StreamClass::video), A = trace_flags(false, StreamClass::audio);
    // An outage 3.5 s long ending at T + 5 s: one buffer 3.5 s before it, none between;
    // a 2.5 s stretch with no records and no OUTAGE is filled every 0.5 s.
    std::vector<TraceRecord> t = table(T);
    for (int k = 0; k <= 10; k++) {
        t.push_back(rec(T + k * 100 * MS, TraceKind::pcr, 0x100, (uint64_t)(k * 2700000), V));
        t.push_back(rec(T + k * 100 * MS, TraceKind::pes, 0x101, (uint64_t)(36000 + k * 9000), A));
    }
    t.push_back(rec(T + 5 * S, TraceKind::outage, PID_NULL, 3500 * MS));
    t.push_back(rec(T + 5 * S, TraceKind::pcr, 0x100, 5 * 27000000, V));
    t.push_back(rec(T + 7500 * MS, TraceKind::pcr, 0x100, 7500 * 27000, V));
    std::vector<TracePlayer::Buffer> bs = buffers_of(t);
    std::vector<int64_t> at;
    for (const TracePlayer::Buffer& b : bs) at.push_back(b.arrival_ns - T);
    const std::vector<int64_t> want = {0, 100 * MS, 200 * MS, 300 * MS, 400 * MS, 500 * MS, 600 * MS, 700 * MS,
                                       800 * MS, 900 * MS, 1000 * MS, 1500 * MS, 5000 * MS, 5500 * MS, 6000 * MS,
                                       6500 * MS, 7000 * MS, 7500 * MS};
    CHECK("player: an outage is the recorded silence (one buffer at its start), a stretch without one is filled",
          at == want && bs[11].bytes.size() == PKT && ts_pid(bs[11].bytes.data()) == PID_NULL);
    Played p = play(t, {0x101});
    CHECK("player: replayed, the outage records again as it was, and nothing else is one",
          p.trace == t && p.misplaced == 0);

    // A header held across buffers, with a PCR of its own PID between its two packets.
    t = table(T);
    t.push_back(rec(T, TraceKind::pcr, 0x100, 0, V));
    t.push_back(rec(T, TraceKind::pes, 0x100, 54000, V, -3600));
    t.push_back(rec(T + 40 * MS, TraceKind::pcr, 0x100, 40 * 27000, V));
    t.push_back(rec(T + 20 * MS, TraceKind::pes, 0x100, 57600, V));   // held: timed at its first packet
    t.push_back(rec(T + 60 * MS, TraceKind::pcr, 0x100, 60 * 27000, V));
    bs = buffers_of(t);
    bool first_cut = bs.size() == 4 && bs[1].arrival_ns == T + 20 * MS && bs[1].bytes.size() == PKT;
    if (first_cut) {
        PacketView v;
        uint8_t* q = bs[1].bytes.data();
        parse_packet(q, &v);
        PesHeader h;
        first_cut = v.pusi && v.pid == 0x100 && PKT - v.payload_off == 9 &&
                    parse_pes_header(q + v.payload_off, 9, &h) && !h.complete;
    }
    CHECK("player: a held header's first packet goes where it arrived, cut short of its PTS", first_cut);
    p = play(t, {0x100});
    CHECK("player: ... joined with its continuation where it was recorded, PCR between, as recorded",
          p.trace == t && p.misplaced == 0 && p.stats.header_spans == 1 && p.out.pes[0x100].size() == 2);

    // Records no recorder writes: counted, never a crash.
    t = table(T);
    t.push_back(rec(T + 10 * MS, TraceKind::pcr, 0x100, 10 * 27000, V));
    t.push_back(rec(T - 5 * S, TraceKind::pes, 0x101, 9000, A));         // older than every buffer
    t.push_back(rec(T + 20 * MS, (TraceKind)7, 0x101, 1));              // a kind from the future
    t.push_back(rec(T + 30 * MS, TraceKind::outage, PID_NULL, 300 * MS));  // too short for an outage
    CHECK("player: an unplaceable PES, an unknown kind and a short outage are counted as misplaced",
          [&] {
              TracePlayer pl(t, RestampCore::OUTAGE_NS);
              TracePlayer::Buffer b;
              while (pl.next(&b)) {
              }
              return pl.misplaced() == 3;
          }());

    // A PMT whose version alone moved records its table again, identical: replayed, the
    // second table must reach the core as a change too.
    t = table(T);
    t.push_back(rec(T + 10 * MS, TraceKind::pcr, 0x100, 10 * 27000, V));
    for (const TraceRecord& r : table(T + 1 * S)) t.push_back(r);
    t.push_back(rec(T + 1010 * MS, TraceKind::pcr, 0x100, 1010 * 27000, V));
    p = play(t, {0x101});
    CHECK("player: a table recorded twice, unchanged (a version-only PMT change), replays as two",
          p.trace == t && p.misplaced == 0);

    // Two programs' tables in one buffer: one PAT naming both; PMT PIDs off the trace's PIDs.
    t = table(T, 1, 0x1000, 0x1001);
    for (const TraceRecord& r : table(T, 7, 0x200, 0x201)) t.push_back(r);
    t.push_back(rec(T + 10 * MS, TraceKind::pcr, 0x1000, 0, V));
    t.push_back(rec(T + 10 * MS, TraceKind::pcr, 0x200, 0, V));
    bs = buffers_of(t);
    int pats = 0, pmt_on_es = 0;
    for (size_t i = 0; i + PKT <= bs[0].bytes.size(); i += PKT) {
        const int pid = ts_pid(bs[0].bytes.data() + i);
        pats += pid == PID_PAT;
        pmt_on_es += pid == 0x1000 || pid == 0x1001 || pid == 0x200 || pid == 0x201;
    }
    p = play(t, {0x1001, 0x201});
    CHECK("player: one PAT for the programs of one buffer, PMT PIDs clear of the trace's, both replay",
          pats == 1 && pmt_on_es == 0 && p.trace == t && p.stats.programs.size() == 2);
}

// --- The generator (trace_gen.h, fixture_gen --trace) ---------------------------------

uint64_t fnv(const std::vector<TraceRecord>& v) {
    uint64_t h = 1469598103934665603ULL;
    for (const TraceRecord& r : v) {
        uint8_t b[TRACE_RECORD_BYTES];
        encode_trace_record(r, b);
        for (uint8_t x : b) {
            h ^= x;
            h *= 1099511628211ULL;
        }
    }
    return h;
}

void test_generator() {
    trace_gen::Config c;
    const std::vector<TraceRecord> a = trace_gen::generate(c), b = trace_gen::generate(c);
    c.seed = 2;
    const std::vector<TraceRecord> d = trace_gen::generate(c);
    std::printf("  generator: %zu records for 120 s, checksum %016llx\n", a.size(), (unsigned long long)fnv(a));
    CHECK("generator: one seed, the same records; another seed, other arrivals only",
          a == b && !(a == d) && a.size() == d.size() && [&] {
              for (size_t i = 0; i < a.size(); i++)
                  if (a[i].value != d[i].value || a[i].kind != d[i].kind || a[i].pid != d[i].pid) return false;
              return true;
          }());
    // Pins the bytes on every machine (integer arithmetic only, as ts_stc_test's sums):
    // a change to it must be deliberate.
    CHECK("generator: the default trace's checksum is 832e8bd4d56c5e57", fnv(a) == 0x832e8bd4d56c5e57ULL);
    int pcr = 0, pes[4] = {0, 0, 0, 0};
    bool fifo = true, psi_first = a.size() > 4 && a[0].kind == TraceKind::psi && (a[0].value & TRACE_PSI_PCR);
    for (size_t i = 0; i < a.size(); i++) {
        pcr += a[i].kind == TraceKind::pcr;
        if (a[i].kind == TraceKind::pes) pes[a[i].pid - 0x100]++;
        if (i) fifo &= a[i].arrival_ns >= a[i - 1].arrival_ns;
    }
    CHECK("generator: the table first, PCR every 100 ms, every PES of the three ES, arrivals in order",
          psi_first && pcr == 1200 && pes[0] == 3000 && pes[1] == 5000 && pes[2] == 5625 && pes[3] == 0 && fifo);
    // Rate: --ppm +50 makes the source fast, the arrivals 50 us/s slower than its PCR.
    c = trace_gen::Config();
    c.seed = 3;
    c.jitter_mean_ns = 0;
    c.ppb = trace_gen::Schedule{{{0, 50000}}};
    const std::vector<TraceRecord> f = trace_gen::generate(c);
    int64_t first_h = -1, first_s = 0, last_h = 0, last_s = 0;
    for (const TraceRecord& r : f)
        if (r.kind == TraceKind::pcr) {
            if (first_h < 0) first_h = r.arrival_ns, first_s = pcr27_to_ns((int64_t)r.value);
            last_h = r.arrival_ns;
            last_s = pcr27_to_ns((int64_t)r.value);
        }
    const int64_t dh = last_h - first_h, ds = last_s - first_s;
    CHECK("generator: --ppm 50 is a fast source: house runs 50 ppm slow against its PCR (no jitter)",
          ds > 119 * S && iabs64((dh - ds) + ds / 20000) <= 100);
    // The wrap, a flagged jump, an outage.
    c = trace_gen::Config();
    c.wrap_at_ns = 5 * S;
    c.jumps.push_back({60 * S, 30 * S, true});
    c.outages.push_back({90 * S, 3 * S});
    const std::vector<TraceRecord> g = trace_gen::generate(c);
    int64_t prev = -1, wrap_t = -1, di_t = -1, outage = -1, outage_t = -1;
    for (const TraceRecord& r : g) {
        if (r.kind == TraceKind::pcr) {
            if (prev >= 0 && (int64_t)r.value < prev && wrap_t < 0) wrap_t = r.arrival_ns - g[0].arrival_ns;
            prev = (int64_t)r.value;
            if ((r.flags & TRACE_FLAG_DISCONTINUITY) && di_t < 0) di_t = r.arrival_ns - g[0].arrival_ns;
        }
        if (r.kind == TraceKind::outage) {
            outage = (int64_t)r.value;
            outage_t = r.arrival_ns - g[0].arrival_ns;
        }
    }
    CHECK("generator: --wrap-at 5: the PCR wraps 5 s in; the flagged jump's PCR at 60 s; one OUTAGE of ~3 s at 93 s",
          wrap_t > 4900 * MS && wrap_t < 5100 * MS && di_t > 59900 * MS && di_t < 60100 * MS && outage > 2950 * MS &&
              outage < 3060 * MS && outage_t > 92900 * MS && outage_t < 93100 * MS);
}

// Generated traces through the player into RestampCore: the epochs part 7.2 names, and
// the replay recording what it played.
void test_generated_replays() {
    struct Case {
        const char* name;
        trace_gen::Config c;
        int relocks;
        const char* reason;
        uint32_t epoch;
        int64_t gap_lo, gap_hi;           // every gap's length
        int gaps_per_pid;                 // -1: not checked
    };
    std::vector<Case> cases;
    {
        Case k{"outage, PCR continuous", trace_gen::Config(), 0, "", 1, 2990 * MS, 3020 * MS, 1};
        k.c.outages.push_back({60 * S, 3 * S});
        cases.push_back(k);
    }
    {
        Case k{"flagged +30 s discontinuity", trace_gen::Config(), 1, "discontinuity", 2, 0, 20 * MS, -1};
        k.c.jumps.push_back({60 * S, 30 * S, true});
        cases.push_back(k);
    }
    {
        Case k{"unflagged 1 s rewind", trace_gen::Config(), 1, "leap", 2, 0, 20 * MS, -1};
        k.c.jumps.push_back({60 * S, -1 * S, false});
        cases.push_back(k);
    }
    {
        Case k{"floor +30 ms at 50 s", trace_gen::Config(), 1, "envelope-step", 2, 20 * MS, 40 * MS, 1};
        k.c.delay_ns = trace_gen::Schedule{{{0, 20 * MS}, {50 * S, 50 * MS}}};
        cases.push_back(k);
    }
    for (const Case& k : cases) {
        const std::vector<TraceRecord> t = trace_gen::generate(k.c);
        const Played p = play(t, {0x100, 0x101, 0x102});
        int relocks = 0, reason_ok = 0;
        std::map<int, int> gaps;
        bool gap_ok = true;
        for (const Ev& e : p.events) {
            if (e.kind == Ev::Kind::relock) {
                relocks++;
                reason_ok += !std::strcmp(e.reason, k.reason);
            }
            if (e.kind == Ev::Kind::gap) {
                gaps[e.pid]++;
                gap_ok &= e.gap_ns >= k.gap_lo && e.gap_ns <= k.gap_hi;
            }
        }
        bool per_pid = k.gaps_per_pid < 0 || gaps.size() == 3;
        for (const auto& kv : gaps) per_pid &= k.gaps_per_pid < 0 || kv.second == k.gaps_per_pid;
        const RestampCore::ProgramStats& ps = p.stats.programs[0];
        std::printf("  replay [%s]: %d relocks (%s), epoch %u, %llu gaps, %llu PES dropped, ppb %lld\n", k.name,
                    relocks, relocks ? k.reason : "-", ps.clock.epoch, (unsigned long long)ps.gaps,
                    (unsigned long long)ps.dropped_pes, (long long)ps.clock.ppb);
        CHECK((std::string("generated [") + k.name + "]: the expected epochs, relock reason and gaps").c_str(),
              relocks == k.relocks && reason_ok == k.relocks && ps.clock.epoch == k.epoch && gap_ok && per_pid &&
                  (k.gaps_per_pid < 0 || !gaps.empty()));
        CHECK((std::string("generated [") + k.name + "]: the replay records the trace it played").c_str(),
              p.trace == t && p.misplaced == 0);
    }
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
    test_memory_writer();
    test_player_fidelity();
    test_player_cases();
    test_generator();
    test_generated_replays();
    for (const std::string& f : g_files) std::remove(f.c_str());
    rmdir(g_dir.c_str());
    return test_summary("ts_trace");
}
