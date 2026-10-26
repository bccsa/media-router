// ts_rebase (plan ch. 7 WI-P3-3): the rewrite under `mrts_cli rebase` and `fixture_gen
// --respace`, on every committed fixture (tests/fixtures; MRTS_FIXTURES overrides): +x then -x
// byte-identical at +-1 h and across 2^33; every PES PTS/DTS and PCR base moved by the shift
// and nothing else changed; PTS - PCR per PCR kept; headers split over two packets rewritten
// across both; the re-spacing about the first PES, its PCR included.
#include <dirent.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "../ts_dump.h"
#include "../ts_rebase.h"
#include "check.h"
#include "ts_gen.h"

using namespace mrts;
using ts_gen::Bytes;

namespace {

constexpr int64_t HOUR = 3600LL * 90000;

std::string fixtures_dir(const char* argv0) {
    if (const char* e = std::getenv("MRTS_FIXTURES")) return e;
    std::string a = argv0;
    const size_t slash = a.rfind('/');
    return (slash == std::string::npos ? std::string(".") : a.substr(0, slash)) + "/../../../tests/fixtures";
}

std::vector<std::pair<std::string, Bytes>> committed(const std::string& dir) {
    std::vector<std::pair<std::string, Bytes>> out;
    std::vector<std::string> names;
    if (DIR* d = opendir(dir.c_str())) {
        while (dirent* e = readdir(d)) {
            const std::string n = e->d_name;
            if (n.size() > 3 && n.compare(n.size() - 3, 3, ".ts") == 0) names.push_back(n);
        }
        closedir(d);
    }
    std::sort(names.begin(), names.end());
    for (const std::string& n : names) {
        Bytes b;
        if (std::FILE* f = std::fopen((dir + "/" + n).c_str(), "rb")) {
            uint8_t buf[65536];
            size_t k;
            while ((k = std::fread(buf, 1, sizeof buf, f)) > 0) b.insert(b.end(), buf, buf + k);
            std::fclose(f);
        }
        out.push_back({n, b});
    }
    return out;
}

int64_t mod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

int64_t read_field(const uint8_t* f) {
    return ((int64_t)((f[0] >> 1) & 0x07) << 30) | ((int64_t)f[1] << 22) | ((int64_t)(f[2] >> 1) << 15) |
           ((int64_t)f[3] << 7) | (f[4] >> 1);
}

using Map = std::function<int64_t(int64_t)>;

// b is a with every PES PTS/DTS through `pts` and every PCR through `pcr` and nothing else
// changed: per packet, a byte may differ only in a PCR field or a PES header's timestamp
// fields (a split header's in the PUSI packet's tail and its continuation's head), and each
// such field reads as mapped. A split header's values are checked by the dump (dump_moved).
bool moved_exactly(const Bytes& a, const Bytes& b, const Map& pts, const Map& pcr, std::string* why) {
    if (a.size() != b.size()) return *why = "sizes differ", false;
    std::vector<size_t> offs;
    PacketWalker w;
    w.feed(a.data(), a.size(), [&](const PacketView& v) { offs.push_back((size_t)(v.p - a.data())); });
    std::vector<char> free_at(a.size(), 0);   // bytes allowed to differ
    std::vector<int> split(8192, 0);          // a PID whose header continues: bytes of it still to come
    for (size_t o : offs) {
        PacketView v;
        parse_packet(const_cast<uint8_t*>(a.data() + o), &v);
        if (v.af_pcr) {
            std::fill(free_at.begin() + (long)o + 6, free_at.begin() + (long)o + 12, 1);
            if (read_pcr(b.data() + o) != mod(pcr(read_pcr(a.data() + o)), PCR_MODULO))
                return *why = "a PCR at byte " + std::to_string(o) + " is not mapped", false;
        }
        if (v.payload_off >= PKT) continue;
        const size_t po = o + (size_t)v.payload_off;
        if (split[v.pid] && !v.pusi) {        // a split header's continuation: its first bytes
            std::fill(free_at.begin() + (long)po, free_at.begin() + (long)std::min(po + 19, o + PKT), 1);
            split[v.pid] = 0;
            continue;
        }
        split[v.pid] = 0;
        PesHeader h;
        if (!v.pusi || !parse_pes_header(a.data() + po, PKT - v.payload_off, &h)) continue;
        if (!h.complete) {                    // the fields may run into the PID's next packet
            std::fill(free_at.begin() + (long)po, free_at.begin() + (long)o + PKT, 1);
            split[v.pid] = 1;
            continue;
        }
        if (h.pts < 0) continue;
        for (int off : {h.pts_off, h.dts_off}) {
            if (off < 0) continue;
            std::fill(free_at.begin() + (long)(po + off), free_at.begin() + (long)(po + off + 5), 1);
            const int64_t want = mod(pts(read_field(a.data() + po + off)), PTS_WRAP);
            if (read_field(b.data() + po + off) != want)
                return *why = "a PES timestamp at byte " + std::to_string(po + off) + " is not mapped", false;
        }
    }
    for (size_t i = 0; i < a.size(); i++)
        if (a[i] != b[i] && !free_at[i]) return *why = "byte " + std::to_string(i) + " changed", false;
    return true;
}

// Dump lines of a stream (mrts_cli dump's), and the same with each PES's pts/dts mapped and
// the unwrapped values (derived) cut: b's dump must equal a's so mapped.
std::vector<std::string> dump(const Bytes& in) {
    Bytes data = in;
    std::vector<std::string> lines;
    PesIndex idx([&](const std::string& l) { lines.push_back(l); });
    idx.feed(data.data(), data.size());
    idx.finish();
    return lines;
}

std::string field_cut(const std::string& l, const char* key, const Map* map) {
    const std::string k = std::string("\"") + key + "\":";
    const size_t at = l.find(k);
    if (at == std::string::npos) return l;
    const size_t v = at + k.size(), end = l.find_first_of(",}", v);
    std::string val = l.substr(v, end - v);
    if (val != "null") val = map ? std::to_string(mod((*map)(std::atoll(val.c_str())), PTS_WRAP)) : "*";
    return l.substr(0, v) + val + l.substr(end);
}

bool dump_moved(const Bytes& a, const Bytes& b, const Map& pts, std::string* why) {
    const std::vector<std::string> da = dump(a), db = dump(b);
    if (da.size() != db.size()) return *why = "dumps differ in length", false;
    for (size_t i = 0; i < da.size(); i++) {
        std::string x = da[i], y = db[i];
        for (const char* k : {"ptsUnwrapped", "dtsUnwrapped"}) {
            x = field_cut(x, k, nullptr);
            y = field_cut(y, k, nullptr);
        }
        x = field_cut(field_cut(x, "pts", &pts), "dts", &pts);
        if (x != y) return *why = "dump line " + std::to_string(i + 1) + ": " + y.substr(0, 120), false;
    }
    return true;
}

// Each PCR with the PTS of the next PES start after it (complete headers), in byte order.
std::vector<int64_t> pts_minus_pcr(const Bytes& in) {
    std::vector<int64_t> out;
    std::vector<int64_t> open;                // PCR bases waiting for their next PES
    PacketWalker w;
    w.feed(in.data(), in.size(), [&](const PacketView& v) {
        const int64_t pcr = read_pcr(v.p);
        if (pcr >= 0) open.push_back(pcr / 300);
        if (!v.pusi || v.payload_off >= PKT) return;
        PesHeader h;
        if (!parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) || !h.complete || h.pts < 0) return;
        for (int64_t base : open) out.push_back(mod(h.pts - base, PTS_WRAP));
        open.clear();
    });
    return out;
}

Bytes rebased(Bytes b, int64_t shift) {
    rebase_ts(b.data(), b.size(), shift);
    return b;
}

void test_round_trips(const std::vector<std::pair<std::string, Bytes>>& files) {
    int n = 0;
    for (const auto& f : files) {
        const Bytes& a = f.second;
        const int64_t p0 = first_pes_pts(a.data(), a.size());
        if (p0 < 0) {
            CHECK((f.first + ": has a PES with a PTS").c_str(), false);
            continue;
        }
        // The first PES 1 s before the wrap, so the stream crosses 2^33.
        const int64_t wrap = mod(PTS_WRAP - 90000 - p0, PTS_WRAP);
        bool ident = true, moved = true;
        std::string why;
        for (int64_t s : {HOUR, -HOUR, wrap}) {
            const Bytes b = rebased(a, s);
            ident &= rebased(b, -s) == a && b != a;
            const Map m = [s](int64_t v) { return v + s; };
            const Map pcr = [s](int64_t v) { return mod(v / 300 + s, PTS_WRAP) * 300 + v % 300; };
            if (moved && !(moved_exactly(a, b, m, pcr, &why) && dump_moved(a, b, m, &why))) moved = false;
        }
        CHECK((f.first + ": +x then -x byte-identical at +1 h, -1 h and across 2^33").c_str(), ident);
        CHECK((f.first + ": every PES PTS/DTS and PCR base moved by the shift, nothing else" +
               (moved ? std::string() : " (" + why + ")")).c_str(), moved);
        const Bytes b = rebased(a, wrap);
        CHECK((f.first + ": PTS - PCR per PCR unchanged").c_str(), pts_minus_pcr(a) == pts_minus_pcr(b));
        n++;
    }
    CHECK(("fixtures: " + std::to_string(n) + " committed .ts rebased").c_str(), n >= 14);
}

void test_split_headers() {
    const Bytes a = ts_gen::pes_header_split();
    int pid = -1;
    // The first PES start in byte order is the video's, cut after one byte; the AAC PES between
    // its halves comes later on the wire though its own header is whole.
    CHECK("first PES: a header split over two packets counts at its start (video 93600, not AAC 90900)",
          first_pes_pts(a.data(), a.size(), &pid) == 93600 && pid == 0x100);
    Bytes b = a;
    const TsRewrite r = rebase_ts(b.data(), b.size(), HOUR);
    CHECK("split headers: 72 video headers rewritten across their two packets, none left",
          r.spans == 72 && r.broken == 0 && r.pes == 144);
    std::string why;
    const Map m = [](int64_t v) { return v + HOUR; };
    CHECK("split headers: every PES of the dump moved by the shift, the split ones too",
          dump_moved(a, b, m, &why));
    // Cut short: the last split header without its continuation stays as it was.
    Bytes c(a.begin(), a.begin() + 188 * 4);   // PAT, PMT, the video PUSI packet, the AAC PES
    const TsRewrite rc = rebase_ts(c.data(), c.size(), HOUR);
    const int po = payload_offset(c.data() + 2 * PKT);
    CHECK("split headers: one held at the end is left as it was, counted broken",
          rc.broken == 1 && rc.spans == 0 && std::equal(c.begin() + 2 * PKT + po, c.begin() + 3 * PKT,
                                                        a.begin() + 2 * PKT + po));
}

void test_respace(const std::vector<std::pair<std::string, Bytes>>& files) {
    const auto it = std::find_if(files.begin(), files.end(),
                                 [](const auto& f) { return f.first == "cap-mux-align7-aac-opus.ts"; });
    if (it == files.end()) {
        CHECK("respace: cap-mux-align7-aac-opus.ts present", false);
        return;
    }
    const Bytes& a = it->second;
    const int64_t o = first_pes_pts(a.data(), a.size());
    Bytes b = a;
    const TsRewrite r = respace_ts(b.data(), b.size(), o, 40);
    auto fold = [](int64_t d, int64_t m) {
        const int64_t x = mod(d, m);
        return x > m / 2 ? x - m : x;
    };
    // d + 40 d / 10^6, the 40 ppm part rounded half away from zero.
    auto scale = [](int64_t d) {
        const int64_t e = (std::llabs(d) * 40 + 500000) / 1000000;
        return d + (d < 0 ? -e : e);
    };
    const Map pts = [&](int64_t v) { return o + scale(fold(v - o, PTS_WRAP)); };
    const Map pcr = [&](int64_t v) { return o * 300 + scale(fold(v - o * 300, PCR_MODULO)); };
    std::string why;
    CHECK("respace +40 ppm: every PES timestamp and PCR at (1 + 40e-6) times its distance from the first PES",
          r.pes > 900 && r.pcr > 100 && moved_exactly(a, b, pts, pcr, &why) && dump_moved(a, b, pts, &why));
    CHECK("respace +40 ppm: the first PES stays where it was", first_pes_pts(b.data(), b.size()) == o);
    // 9.6 s in, 40 ppm is 34.6 ticks: the last PCR moved by that, the PES with it.
    int64_t last_a = -1, last_b = -1;
    for (size_t off = 0; off + PKT <= a.size(); off += PKT)
        if (read_pcr(a.data() + off) >= 0) {
            last_a = read_pcr(a.data() + off);
            last_b = read_pcr(b.data() + off);
        }
    const int64_t moved = fold(last_b - last_a, PCR_MODULO), dist = fold(last_a - o * 300, PCR_MODULO);
    CHECK("respace +40 ppm: the PCR moves too (the last one by 40 ppm of its distance, to 1/27 us)",
          last_a >= 0 && std::llabs(moved - dist * 40 / 1000000) <= 1 && moved > 0);
}

}  // namespace

int main(int, char** argv) {
    const auto files = committed(fixtures_dir(argv[0]));
    test_round_trips(files);
    test_split_headers();
    test_respace(files);
    return test_summary("ts_rebase");
}
