// The transform producer retime (branch_retime.cpp) on a real tsdemux, B-204 (MR-034): a span
// the consumer's leaky ingress dropped keeps its epoch, no epoch "predicted to continue the last"
// across it; a source cut or rewind still opens one, put on its stamps; a reading whole 33-bit
// wraps off the epoch's prediction (FRA's +95,443,697.689 ms) is rejected, logged once. Every
// access unit is judged against the time its producer stamped. Log lines are read off fd 2.
#include <fcntl.h>
#include <gst/gst.h>
#include <unistd.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "../branch_retime.h"
#include "../ipc.h"
#include "mrts/tests/check.h"
#include "mrts/tests/ts_gen.h"

namespace {

using ts_gen::Bytes;
constexpr int PID = 0x41, PMT = 0x30;
constexpr int64_t MS = 1000000, S = 1000 * MS;
constexpr int64_t FRAME90 = 2160;          // one MP2 frame at 48 kHz, 24 ms
constexpr int64_t PTS0 = 90000LL * 100;   // content 100 s
constexpr int64_t K0 = 3600 * S;          // the producer's mapping: stamp = K + ns(PES)
const int64_t WRAP_NS = mrts::pts90k_to_ns(1LL << 33);

int64_t ns(int64_t t) { return mrts::pts90k_to_ns(t); }

/** One stream: frame i's PES PTS (33-bit) and the house time its producer stamps it at. */
struct Frame {
    int64_t pts, house;
};

/** Bus buffers of 7 packets, each stamped by its first PES start (else, and with `floor` under
 *  it, the floor, as IdentityStamp), PAT and PMT every 20 frames; then the buffers whose stamp
 *  falls in a `drops` range of frames go, as a leaky ingress drops whole buffers. */
struct Feed {
    struct Buf {
        Bytes data;
        int64_t stamp;
    };
    std::vector<Buf> bufs;
    std::map<int64_t, int64_t> truth;   // serial -> the house time it was stamped at
};

Feed build(const std::vector<Frame>& frames, const std::vector<std::pair<int, int>>& drops = {},
           bool floor_on = true) {
    Feed f;
    Bytes all;
    ts_gen::Mux mux(all);
    std::vector<std::pair<Bytes, int64_t>> pkts;   // a packet and the house time of the PES it starts
    auto take = [&](int64_t house) {
        for (size_t off = 0; off < all.size(); off += mrts::PKT) {
            Bytes p(all.begin() + (long)off, all.begin() + (long)off + mrts::PKT);
            pkts.emplace_back(p, (p[1] & 0x40) ? house : -1);
        }
        all.clear();
    };
    for (size_t i = 0; i < frames.size(); i++) {
        if (i % 20 == 0) {
            mux.pat(1, {{1, PMT}});
            mux.pmt(PMT, 1, PID, {mrts::PmtStream{PID, 0x03, {}}});
            take(-1);
        }
        Bytes es = ts_gen::es_bytes(ts_gen::Es::mp2, 384, (uint32_t)i);
        es[4] = (uint8_t)(i >> 24), es[5] = (uint8_t)(i >> 16), es[6] = (uint8_t)(i >> 8), es[7] = (uint8_t)i;
        const int64_t pts = frames[i].pts & ((1LL << 33) - 1);
        const int64_t pcr = ((pts - 9000) & ((1LL << 33) - 1)) * 300;   // 100 ms behind
        mux.pes(PID, ts_gen::pes(0xC0, pts, -1, es, true), i % 2 == 0 ? pcr : -1);
        take(frames[i].house);
        f.truth[(int64_t)i] = frames[i].house;
    }
    int64_t floor = -1;
    for (size_t i = 0; i < pkts.size(); i += 7) {
        Feed::Buf b;
        int64_t st = -1;
        for (size_t j = i; j < std::min(pkts.size(), i + 7); j++) {
            b.data.insert(b.data.end(), pkts[j].first.begin(), pkts[j].first.end());
            if (st < 0 && pkts[j].second >= 0) st = pkts[j].second;
        }
        if (st < 0 || (floor_on && st < floor)) st = floor < 0 ? frames[0].house : floor;
        floor = st;
        b.stamp = st;
        bool dropped = false;
        for (const auto& [a, z] : drops)
            dropped = dropped || (st >= frames[(size_t)a].house && st < frames[(size_t)z].house);
        if (!dropped) f.bufs.push_back(std::move(b));
    }
    return f;
}

std::mutex g_mu;
std::vector<std::pair<int64_t, int64_t>> g_out;   // (output PTS, serial)

GstPadProbeReturn on_out(GstPad*, GstPadProbeInfo* info, gpointer) {
    GstBuffer* b = GST_PAD_PROBE_INFO_BUFFER(info);
    GstMapInfo m;
    if (!b || !gst_buffer_map(b, &m, GST_MAP_READ)) return GST_PAD_PROBE_OK;
    const int64_t serial =
        m.size >= 8 ? ((int64_t)m.data[4] << 24) | (m.data[5] << 16) | (m.data[6] << 8) | m.data[7] : -1;
    gst_buffer_unmap(b, &m);
    std::lock_guard<std::mutex> l(g_mu);
    g_out.emplace_back((int64_t)GST_BUFFER_PTS(b), serial);
    return GST_PAD_PROBE_OK;
}

void on_pad(GstElement*, GstPad* pad, gpointer pipe) {
    GstElement* sink = gst_element_factory_make("fakesink", nullptr);
    g_object_set(sink, "sync", FALSE, "async", FALSE, nullptr);
    gst_bin_add(GST_BIN(pipe), sink);
    gst_element_sync_state_with_parent(sink);
    GstPad* sp = gst_element_get_static_pad(sink, "sink");
    gst_pad_link(pad, sp);
    // On the sink: after the retime's own probe on the demux pad.
    gst_pad_add_probe(sp, GST_PAD_PROBE_TYPE_BUFFER, on_out, nullptr, nullptr);
    gst_object_unref(sp);
}

/** fd 2 into a file while a run logs, read back after: the retime's `branchAlign:` lines. */
std::vector<std::string> g_lines;

struct Result {
    size_t out = 0, judged = 0;
    int64_t worst = 0;   // |output - stamped house time|, ns
    std::vector<std::string> lines;
    bool has(const char* s) const {
        for (const auto& l : lines)
            if (l.find(s) != std::string::npos) return true;
        return false;
    }
    int count(const char* s) const {
        int n = 0;
        for (const auto& l : lines) n += l.find(s) != std::string::npos;
        return n;
    }
};

Result run(const Feed& f) {
    {
        std::lock_guard<std::mutex> l(g_mu);
        g_out.clear();
    }
    char path[] = "/tmp/mr-retime-test-XXXXXX";
    const int fd = mkstemp(path);
    const int saved = dup(2);
    fflush(stderr);
    dup2(fd, 2);
    GstElement* pipe = gst_parse_launch(
        "appsrc name=src format=time caps=\"video/mpegts,systemstream=(boolean)true,packetsize=(int)188\" "
        "! tsdemux name=demux latency=0",
        nullptr);
    GstElement* src = gst_bin_get_by_name(GST_BIN(pipe), "src");
    GstElement* demux = gst_bin_get_by_name(GST_BIN(pipe), "demux");
    mr::align::rt::install("demux_0", (GstElement*)gst_object_ref(demux), gst_element_get_static_pad(demux, "sink"),
                           false);
    g_signal_connect(demux, "pad-added", G_CALLBACK(on_pad), pipe);
    gst_element_set_state(pipe, GST_STATE_PLAYING);
    for (const auto& b : f.bufs) {
        GstBuffer* gb = gst_buffer_new_memdup(b.data.data(), b.data.size());
        GST_BUFFER_PTS(gb) = GST_BUFFER_DTS(gb) = (GstClockTime)b.stamp;
        GstFlowReturn r;
        g_signal_emit_by_name(src, "push-buffer", gb, &r);
        gst_buffer_unref(gb);
    }
    GstFlowReturn r;
    g_signal_emit_by_name(src, "end-of-stream", &r);
    GstBus* bus = gst_element_get_bus(pipe);
    if (GstMessage* m = gst_bus_timed_pop_filtered(bus, 10 * GST_SECOND,
                                                   (GstMessageType)(GST_MESSAGE_EOS | GST_MESSAGE_ERROR)))
        gst_message_unref(m);
    gst_object_unref(bus);
    gst_element_set_state(pipe, GST_STATE_NULL);
    mr::align::rt::clear();
    gst_object_unref(demux);
    gst_object_unref(src);
    gst_object_unref(pipe);
    fflush(stderr);
    dup2(saved, 2);
    close(saved);
    Result res;
    FILE* in = fopen(path, "r");
    char line[2048];
    while (in && fgets(line, sizeof line, in))
        if (std::strstr(line, "branchAlign: ")) res.lines.emplace_back(std::strstr(line, "branchAlign: ") + 13);
    if (in) fclose(in);
    close(fd);
    unlink(path);
    std::lock_guard<std::mutex> l(g_mu);
    res.out = g_out.size();
    for (const auto& [pts, s] : g_out) {
        auto it = f.truth.find(s);
        if (it == f.truth.end()) continue;
        res.judged++;
        res.worst = std::max<int64_t>(res.worst, std::llabs(pts - it->second));
    }
    return res;
}

/** n frames from content PTS0 on the producer's mapping K0, real time. */
std::vector<Frame> steady(int n) {
    std::vector<Frame> v;
    for (int i = 0; i < n; i++) {
        const int64_t pts = PTS0 + i * FRAME90;
        v.push_back({pts, K0 + ns(pts)});
    }
    return v;
}

void print(const char* tag, const Result& r) {
    std::printf("  (%s: %zu access units out, %zu judged, worst %.3f ms; %zu retime lines)\n", tag, r.out, r.judged,
                r.worst / 1e6, r.lines.size());
    for (const auto& l : r.lines) std::printf("    %s", l.c_str());
}

}  // namespace

int main(int argc, char** argv) {
    gst_init(&argc, &argv);
    mr::ipc::init();
    if (!gst_element_factory_find("tsdemux") || !gst_element_factory_find("appsrc")) {
        std::printf("SKIP branch_retime_test: tsdemux or appsrc unavailable\n");
        return 0;
    }
    const int N = 750;   // 18 s of 24 ms frames

    // 1. The consumer's leaky ingress drops 5.5 s, then 6 s more: the stamps jump with the PES.
    const Result drop = run(build(steady(N), {{125, 354}, {380, 630}}));
    print("drops", drop);
    CHECK("drop: every access unit leaves at the time its producer stamped (within 1 ms)",
          drop.judged > 250 && drop.worst <= MS);
    CHECK("drop: no epoch predicted to continue the last across a dropped span (no discontinuity)",
          !drop.has("PTS discontinuity") && !drop.has("off the prediction"));
    CHECK("drop: the hole is logged once for two, naming the epoch that holds",
          drop.count("a hole of +5.520 s in its PES that its stamps share (dropped upstream)") == 1 &&
              drop.count("a hole of") == 1 && drop.has("stamp epoch #0 holds (logged once)"));

    // 2. A source cut 6 s forward and a 427 s rewind, house time running on: a new mapping, a fresh
    //    epoch predicted to continue the last, which its stamps then confirm (as before B-204).
    for (const int64_t jump : {6 * 90000LL, -427 * 90000LL}) {
        std::vector<Frame> v = steady(N);
        for (int i = 250; i < N; i++) v[i].pts += jump;
        const Result cut = run(build(v));
        print(jump > 0 ? "cut +6 s" : "rewind -427 s", cut);
        CHECK(jump > 0 ? "cut: a fresh epoch, predicted, confirmed on its stamps, every unit on its stamp"
                       : "rewind: the same for a 427 s rewind",
              cut.judged > 700 && cut.worst <= MS && cut.has("PTS discontinuity") &&
                  cut.has("epoch #1 on its stamps, +0.000 ms off the prediction") && !cut.has("a hole of"));
    }

    // 3. FRA's 'SCC -> ENG (10)' at 09:34:43Z: back from 82,288 s away (its PES folds to -13,155.8 s),
    //    the first 2 s of stamps one wrap less 20 ms ahead of the house time (the leaked PES's), then
    //    right. The off-wrap readings are rejected; the epoch rides its prediction, then its stamps.
    {
        std::vector<Frame> v = steady(N);
        const int64_t back = -1184023440LL;   // -13,155.816 s in 90 kHz ticks
        for (int i = 250; i < N; i++) {
            v[i].pts += back;
            if (i < 333) v[i].house += WRAP_NS - 20 * MS;
        }
        const Feed f = build(v, {}, false);   // the producer's guard drops its floor (B-203)
        Feed judged = f;
        for (int i = 250; i < 333; i++) judged.truth[i] -= WRAP_NS - 20 * MS;   // where they belong
        const Result wrap = run(judged);
        print("FRA's return", wrap);
        CHECK("wrap: no access unit one wrap off: each on the house time it belongs to (within 1 ms)",
              wrap.judged > 700 && wrap.worst <= MS);
        CHECK("wrap: the reading a wrap off the prediction is rejected, logged once",
              wrap.count("a whole number of 33-bit wraps — rejected (logged once)") == 1 &&
                  wrap.has("epoch #1 a stamp reading +95443697.689 ms off its prediction"));
        CHECK("wrap: then the right stamps put the epoch on its stamps, on its prediction",
              wrap.has("epoch #1 on its stamps, +0.000 ms off the prediction") && !wrap.has("K moved"));
    }
    return test_summary("branch_retime");
}
