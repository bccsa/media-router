// Port of ts_split_test.py — splitter-core behavior tests (no transport).
#include <algorithm>
#include <cstring>
#include <deque>
#include <map>
#include <set>
#include <vector>

#include "../ts_psi.h"
#include "../ts_split.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int VIDEO_PID = 0x65;
constexpr int AUDIO_PID = 0xC9;
constexpr int PMT_PID = 0x30;

using Bytes = std::vector<uint8_t>;

void append_pkt(Bytes& out, const uint8_t* p) { out.insert(out.end(), p, p + PKT); }

Bytes es_packet(int pid, int cc, bool pusi, uint8_t fill = 0xAA) {
    Bytes pkt = {SYNC_BYTE, (uint8_t)((pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1F)),
                 (uint8_t)(pid & 0xFF), (uint8_t)(0x10 | (cc & 0x0F))};
    pkt.resize(PKT, fill);
    return pkt;
}

// Synthetic MPTS: PAT + PMT (program 1: video 0x65 = PCR pid, audio 0xC9),
// interleaved ES with correct CCs, PCR packets on the video pid.
Bytes build_source(int n_video = 200, int n_audio = 40, int psi_every = 50,
                   int pcr_every = 20) {
    Bytes out;
    uint8_t tmp[PKT];
    int cc_pat = 0, cc_pmt = 0, cc_v = 0, cc_a = 0;
    int64_t pcr = 27000000;
    int vi = 0, ai = 0, i = 0;
    while (vi < n_video || ai < n_audio) {
        if (i % psi_every == 0) {
            build_pat(7, {{1, PMT_PID}}, cc_pat, 0, tmp);
            cc_pat = (cc_pat + 1) & 0xF;
            append_pkt(out, tmp);
            build_pmt(PMT_PID, 1, VIDEO_PID,
                      {{VIDEO_PID, STREAM_TYPE_AVC, {}}, {AUDIO_PID, STREAM_TYPE_AAC, {}}},
                      cc_pmt, 0, tmp);
            cc_pmt = (cc_pmt + 1) & 0xF;
            append_pkt(out, tmp);
        }
        if (i % pcr_every == 0 && vi < n_video) {
            pcr += 27000000 / 50;
            build_pcr_packet(VIDEO_PID, pcr, cc_v, tmp);
            append_pkt(out, tmp);
        }
        for (int k = 0; k < 4; k++)
            if (vi < n_video) {
                Bytes p = es_packet(VIDEO_PID, cc_v, vi % 10 == 0);
                out.insert(out.end(), p.begin(), p.end());
                cc_v = (cc_v + 1) & 0xF;
                vi++;
            }
        if (ai < n_audio) {
            Bytes p = es_packet(AUDIO_PID, cc_a, ai % 5 == 0, 0xBB);
            out.insert(out.end(), p.begin(), p.end());
            cc_a = (cc_a + 1) & 0xF;
            ai++;
        }
        i++;
    }
    return out;
}

struct RunResult {
    std::vector<std::vector<std::pair<int, int>>> discovered;   // streams per event
    std::vector<std::vector<std::pair<int, Bytes>>> es_info;
    std::map<int, Bytes> out;
    long long desync_bytes = 0;
};

RunResult run_core(const Bytes& source, size_t chunk,
                   std::vector<SplitterCore::OutputSpec> specs = {{VIDEO_PID, -1},
                                                                  {AUDIO_PID, -1}}) {
    RunResult r;
    SplitterCallbacks cb;
    cb.on_discovered = [&](const std::vector<std::pair<int, int>>& s, int,
                           const std::vector<std::pair<int, Bytes>>& e) {
        r.discovered.push_back(s);
        r.es_info.push_back(e);
    };
    SplitterCore core(1, specs, cb);
    for (size_t off = 0; off < source.size(); off += chunk) {
        size_t n = std::min(chunk, source.size() - off);
        for (const auto& b : core.feed(source.data() + off, n))
            r.out[b.pid].insert(r.out[b.pid].end(), b.data->begin(), b.data->end());
    }
    r.desync_bytes = core.desync_bytes();
    return r;
}

std::vector<Bytes> packets_of(const Bytes& ts) {
    std::vector<Bytes> out;
    for (size_t off = 0; off + PKT <= ts.size(); off += PKT)
        if (ts[off] == SYNC_BYTE) out.push_back(Bytes(ts.begin() + off, ts.begin() + off + PKT));
    return out;
}

std::vector<Bytes> es_only(const Bytes& ts, int pid) {
    std::vector<Bytes> out;
    for (auto& p : packets_of(ts))
        if (ts_pid(p.data()) == pid && ts_has_payload(p.data())) out.push_back(p);
    return out;
}

std::set<int> pids_in(const Bytes& ts) {
    std::set<int> s;
    for (auto& p : packets_of(ts)) s.insert(ts_pid(p.data()));
    return s;
}

std::deque<TsPacket> deque_of(const std::vector<Bytes>& pkts) {
    std::deque<TsPacket> d;
    for (auto& p : pkts) {
        d.emplace_back();
        std::memcpy(d.back().b, p.data(), PKT);
    }
    return d;
}

int pmt_version_of(const Bytes& ts) {
    std::vector<Bytes> pmt_pkts;
    for (auto& p : packets_of(ts))
        if (ts_pid(p.data()) == SPLIT_PMT_PID) pmt_pkts.push_back(p);
    std::vector<uint8_t> sec;
    if (!first_section(deque_of(pmt_pkts), SPLIT_PMT_PID, sec)) return -1;
    return (sec[5] >> 1) & 0x1F;
}

Bytes build_video_source(int stream_type, int n_video = 400, int psi_every = 2) {
    Bytes out;
    uint8_t tmp[PKT];
    int cc_pat = 0, cc_pmt = 0, cc_v = 0;
    for (int i = 0; i < n_video; i++) {
        if (i % psi_every == 0) {
            build_pat(7, {{1, PMT_PID}}, cc_pat, 0, tmp);
            cc_pat = (cc_pat + 1) & 0xF;
            append_pkt(out, tmp);
            build_pmt(PMT_PID, 1, VIDEO_PID, {{VIDEO_PID, stream_type, {}}}, cc_pmt, 0, tmp);
            cc_pmt = (cc_pmt + 1) & 0xF;
            append_pkt(out, tmp);
        }
        Bytes p = es_packet(VIDEO_PID, cc_v, i % 10 == 0);
        out.insert(out.end(), p.begin(), p.end());
        cc_v = (cc_v + 1) & 0xF;
    }
    return out;
}

}  // namespace

int main() {
    Bytes source = build_source();

    // --- chunking invariance: 400-byte slices vs one blob ---
    auto a = run_core(source, 400);
    auto b = run_core(source, source.size());
    CHECK("chunking invariance (video ES)",
          es_only(a.out[VIDEO_PID], VIDEO_PID) == es_only(b.out[VIDEO_PID], VIDEO_PID));
    CHECK("chunking invariance (audio ES)",
          es_only(a.out[AUDIO_PID], AUDIO_PID) == es_only(b.out[AUDIO_PID], AUDIO_PID));

    // --- output purity ---
    CHECK("video output pids = {PAT, PMT, video}",
          pids_in(a.out[VIDEO_PID]) == std::set<int>({0x0000, SPLIT_PMT_PID, VIDEO_PID}));
    CHECK("audio output pids = {PAT, PMT, audio}",
          pids_in(a.out[AUDIO_PID]) == std::set<int>({0x0000, SPLIT_PMT_PID, AUDIO_PID}));

    // --- ES pass-through: byte-identical to the source ---
    CHECK("video ES byte-identical",
          es_only(a.out[VIDEO_PID], VIDEO_PID) == es_only(source, VIDEO_PID));
    CHECK("audio ES byte-identical",
          es_only(a.out[AUDIO_PID], AUDIO_PID) == es_only(source, AUDIO_PID));

    // --- PSI cadence + parse-back ---
    auto video_pkts = packets_of(a.out[VIDEO_PID]);
    size_t first_es = 0;
    while (first_es < video_pkts.size() &&
           !(ts_pid(video_pkts[first_es].data()) == VIDEO_PID &&
             ts_has_payload(video_pkts[first_es].data())))
        first_es++;
    std::set<int> before;
    for (size_t i = 0; i < first_es; i++) before.insert(ts_pid(video_pkts[i].data()));
    CHECK("PSI precedes first ES", before.count(0x0000) && before.count(SPLIT_PMT_PID));
    int gap = 0, max_gap = 0;
    for (auto& p : video_pkts) {
        if (ts_pid(p.data()) == VIDEO_PID) {
            gap++;
            max_gap = std::max(max_gap, gap);
        } else if (ts_pid(p.data()) == 0x0000) {
            gap = 0;
        }
    }
    CHECK("PSI at least every ~40 ES pkts (batch-quantized)", max_gap <= 60);
    std::vector<Bytes> pat_pkts, pmt_pkts;
    for (auto& p : video_pkts) {
        if (ts_pid(p.data()) == 0x0000) pat_pkts.push_back(p);
        if (ts_pid(p.data()) == SPLIT_PMT_PID) pmt_pkts.push_back(p);
    }
    CHECK("output PAT -> program 1 on 0x1000",
          parse_pat(deque_of(pat_pkts)) ==
              std::vector<std::pair<int, int>>({{1, SPLIT_PMT_PID}}));
    auto out_pmt = parse_pmt(deque_of(pmt_pkts), SPLIT_PMT_PID);
    CHECK("output PMT: single ES, discovered stream_type",
          out_pmt && out_pmt->pcr_pid == VIDEO_PID && out_pmt->streams.size() == 1 &&
              out_pmt->streams[0].pid == VIDEO_PID &&
              out_pmt->streams[0].stream_type == STREAM_TYPE_AVC);

    // --- PCR re-injection: audio only, CC-correct, monotonic ---
    auto adaptation_only = [](const Bytes& ts, int pid) {
        std::vector<Bytes> out;
        for (auto& p : packets_of(ts))
            if (ts_pid(p.data()) == pid && !ts_has_payload(p.data())) out.push_back(p);
        return out;
    };
    auto audio_pcr = adaptation_only(a.out[AUDIO_PID], AUDIO_PID);
    CHECK("audio output has injected PCR packets", audio_pcr.size() >= 2);
    CHECK("video output: no injected PCRs (source's own pass through)",
          adaptation_only(a.out[VIDEO_PID], VIDEO_PID) == adaptation_only(source, VIDEO_PID));
    bool monotonic = true;
    int64_t prev = -1;
    for (auto& p : audio_pcr) {
        int64_t v = read_pcr(p.data());
        if (v < 0 || v <= prev) monotonic = false;
        prev = v;
    }
    CHECK("injected PCRs monotonic source-copied", monotonic);
    bool ok_cc = true;
    int last_payload_cc = -1;
    for (auto& p : packets_of(a.out[AUDIO_PID])) {
        if (ts_pid(p.data()) != AUDIO_PID) continue;
        if (ts_has_payload(p.data()))
            last_payload_cc = p[3] & 0x0F;
        else if (last_payload_cc >= 0 && (p[3] & 0x0F) != last_payload_cc)
            ok_cc = false;
    }
    CHECK("injected PCR packets carry the last payload CC", ok_cc);

    // --- discovery ---
    CHECK("discovery fired exactly once", a.discovered.size() == 1);
    CHECK("discovery content",
          a.discovered.size() == 1 &&
              a.discovered[0] == std::vector<std::pair<int, int>>(
                                     {{VIDEO_PID, STREAM_TYPE_AVC}, {AUDIO_PID, STREAM_TYPE_AAC}}));
    CHECK("discovery es_info: plain source has empty descriptor loops",
          a.es_info.size() == 1 &&
              std::all_of(a.es_info[0].begin(), a.es_info[0].end(),
                          [](auto& e) { return e.second.empty(); }));

    // --- ES descriptors carried into the rebuilt PMT (Opus identity) ---
    const Bytes opus_desc = {0x05, 0x04, 'O', 'p', 'u', 's', 0x7f, 0x02, 0x80, 0x02};
    Bytes opus_src;
    {
        uint8_t tmp[PKT];
        int cc_pat = 0, cc_pmt = 0, cc_a = 0;
        for (int i = 0; i < 60; i++) {
            if (i % 20 == 0) {
                build_pat(7, {{1, PMT_PID}}, cc_pat, 0, tmp);
                cc_pat = (cc_pat + 1) & 0xF;
                append_pkt(opus_src, tmp);
                build_pmt(PMT_PID, 1, VIDEO_PID,
                          {{VIDEO_PID, STREAM_TYPE_AVC, {}},
                           {AUDIO_PID, STREAM_TYPE_PRIVATE_PES, opus_desc}},
                          cc_pmt, 0, tmp);
                cc_pmt = (cc_pmt + 1) & 0xF;
                append_pkt(opus_src, tmp);
            }
            Bytes p = es_packet(AUDIO_PID, cc_a, i % 5 == 0, 0xBB);
            opus_src.insert(opus_src.end(), p.begin(), p.end());
            cc_a = (cc_a + 1) & 0xF;
        }
    }
    auto opus = run_core(opus_src, 1000, {{AUDIO_PID, -1}});
    std::vector<Bytes> opus_pmt_pkts;
    for (auto& p : packets_of(opus.out[AUDIO_PID]))
        if (ts_pid(p.data()) == SPLIT_PMT_PID) opus_pmt_pkts.push_back(p);
    auto opus_pmt = parse_pmt(deque_of(opus_pmt_pkts), SPLIT_PMT_PID);
    CHECK("split PMT keeps discovered stream_type 0x06",
          opus_pmt && opus_pmt->streams.size() == 1 &&
              opus_pmt->streams[0].stream_type == STREAM_TYPE_PRIVATE_PES);
    CHECK("split PMT carries source ES descriptors verbatim",
          opus_pmt && opus_pmt->streams[0].es_info == opus_desc);
    bool opus_es_info_ok = false;
    if (opus.es_info.size() == 1)
        for (auto& e : opus.es_info[0])
            if (e.first == AUDIO_PID && e.second == opus_desc) opus_es_info_ok = true;
    CHECK("discovery callback carries per-pid es_info", opus_es_info_ok);

    // --- desync recovery ---
    Bytes dirty;
    const char* garbage = "\x00garbage\xffnoise";
    dirty.insert(dirty.end(), garbage, garbage + 14);
    dirty.insert(dirty.end(), source.begin(), source.end());
    auto d = run_core(dirty, 1000);
    CHECK("desync: garbage dropped, ES intact",
          es_only(d.out[VIDEO_PID], VIDEO_PID) == es_only(source, VIDEO_PID) &&
              d.desync_bytes > 0);

    // --- unknown pid ignored, empty feed fine ---
    SplitterCore core_e(1, {{0x999, -1}});
    CHECK("no-match feed returns empty", core_e.feed(source.data(), 188 * 20).empty());
    CHECK("empty feed is a no-op", core_e.feed(source.data(), 0).empty());

    // --- wired-only gating (set_enabled) ---
    SplitterCore core_g(1, {{VIDEO_PID, -1}, {AUDIO_PID, -1}});
    core_g.set_enabled({AUDIO_PID});
    size_t mid = source.size() / 2 / PKT * PKT;
    std::map<int, std::vector<Bytes>> out1;
    for (size_t off = 0; off < mid; off += 1000) {
        size_t n = std::min<size_t>(1000, mid - off);
        for (const auto& bt : core_g.feed(source.data() + off, n))
            out1[bt.pid].push_back(*bt.data);
    }
    CHECK("disabled pid produces nothing", !out1.count(VIDEO_PID) && out1.count(AUDIO_PID));
    core_g.set_enabled({AUDIO_PID, VIDEO_PID});   // re-enable video mid-stream
    std::map<int, std::vector<Bytes>> out2;
    for (size_t off = mid; off < source.size(); off += 1000) {
        size_t n = std::min<size_t>(1000, source.size() - off);
        for (const auto& bt : core_g.feed(source.data() + off, n))
            out2[bt.pid].push_back(*bt.data);
    }
    CHECK("re-enabled pid resumes", out2.count(VIDEO_PID) > 0);
    auto first_batch = packets_of(out2[VIDEO_PID][0]);
    CHECK("re-enable forces PSI before first ES",
          first_batch.size() >= 2 && ts_pid(first_batch[0].data()) == 0x0000 &&
              ts_pid(first_batch[1].data()) == SPLIT_PMT_PID);
    core_g.set_enabled({});
    CHECK("all-disabled feed returns empty", core_g.feed(source.data(), 188 * 40).empty());

    // --- mid-stream codec change bumps the PMT version ---
    std::vector<std::vector<std::pair<int, int>>> events_c;
    SplitterCallbacks cb_c;
    cb_c.on_discovered = [&](const std::vector<std::pair<int, int>>& s, int,
                             const std::vector<std::pair<int, Bytes>>&) {
        events_c.push_back(s);
    };
    SplitterCore core_c(1, {{VIDEO_PID, -1}}, cb_c);
    Bytes avc_src = build_video_source(STREAM_TYPE_AVC);
    Bytes before_out;
    for (const auto& bt : core_c.feed(avc_src.data(), avc_src.size()))
        before_out.insert(before_out.end(), bt.data->begin(), bt.data->end());
    CHECK("pre-switch PMT advertises AVC at version 0", pmt_version_of(before_out) == 0);
    // Switch codec: push >128 new PMT packets, then idle across a 500-boundary.
    Bytes hevc_src = build_video_source(STREAM_TYPE_HEVC);
    for (size_t off = 0; off < hevc_src.size(); off += 2 * PKT) {
        size_t n = std::min<size_t>(2 * PKT, hevc_src.size() - off);
        core_c.feed(hevc_src.data() + off, n);
    }
    for (int i = 0; i < 500; i++) core_c.feed(hevc_src.data(), 0);
    Bytes tail;
    for (const auto& bt : core_c.feed(hevc_src.data(), 40 * PKT))
        tail.insert(tail.end(), bt.data->begin(), bt.data->end());
    CHECK("codec change re-discovered",
          !events_c.empty() &&
              events_c.back() ==
                  std::vector<std::pair<int, int>>({{VIDEO_PID, STREAM_TYPE_HEVC}}));
    std::vector<Bytes> tail_pmt_pkts;
    for (auto& p : packets_of(tail))
        if (ts_pid(p.data()) == SPLIT_PMT_PID) tail_pmt_pkts.push_back(p);
    auto tail_pmt = parse_pmt(deque_of(tail_pmt_pkts), SPLIT_PMT_PID);
    CHECK("post-switch PMT advertises HEVC",
          tail_pmt && tail_pmt->streams.size() == 1 &&
              tail_pmt->streams[0].stream_type == STREAM_TYPE_HEVC);
    CHECK("post-switch PMT version bumped", pmt_version_of(tail) == 1);
    auto tail_pkts = packets_of(tail);
    CHECK("codec change forces PSI before next ES",
          tail_pkts.size() >= 2 && ts_pid(tail_pkts[0].data()) == 0x0000 &&
              ts_pid(tail_pkts[1].data()) == SPLIT_PMT_PID);

    // update() unit behaviour: no-op on same identity, bump on change, mod 32.
    SplitOutput o(VIDEO_PID, 1, STREAM_TYPE_AVC);
    o.update(STREAM_TYPE_AVC, {});
    CHECK("update: same identity keeps version", o.version == 0);
    o.update(STREAM_TYPE_AVC, opus_desc);
    CHECK("update: es_info change bumps version", o.version == 1);
    o.version = 31;
    o.update(STREAM_TYPE_HEVC, opus_desc);
    CHECK("update: version wraps mod 32", o.version == 0);

    // --- on_videoinfo: SPS parsed from a routed video PID ---
    // (SPS fixture identical to ts_video_info_test's 1080i50 capture.)
    const char* sps_hex =
        "67640028ad843fff9087fff210ffffffffffffffff087fffffffffffffff"
        "2cc501e0113f780a10101014000003000400000300ca50";
    Bytes sps;
    for (size_t i = 0; sps_hex[i] && sps_hex[i + 1]; i += 2) {
        auto nib = [](char c) { return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10; };
        sps.push_back((uint8_t)((nib(sps_hex[i]) << 4) | nib(sps_hex[i + 1])));
    }
    auto video_pes_pkts = [&](int pid, int cc0) {
        Bytes es = {0, 0, 0, 1};
        es.insert(es.end(), sps.begin(), sps.end());
        es.insert(es.end(), {0, 0, 1, 0x65});
        es.insert(es.end(), 300, 0xaa);
        Bytes pes = {0, 0, 1, 0xE0, 0, 0, 0x80, 0x00, 0x00};
        pes.insert(pes.end(), es.begin(), es.end());
        Bytes out;
        int cc = cc0;
        bool first = true;
        for (size_t off = 0; off < pes.size(); off += 184) {
            size_t n = std::min<size_t>(184, pes.size() - off);
            Bytes pkt = {SYNC_BYTE, (uint8_t)((first ? 0x40 : 0x00) | ((pid >> 8) & 0x1F)),
                         (uint8_t)(pid & 0xFF), (uint8_t)(0x10 | (cc & 0x0F))};
            pkt.insert(pkt.end(), pes.begin() + off, pes.begin() + off + n);
            pkt.resize(PKT, 0xFF);
            first = false;
            cc = (cc + 1) & 0x0F;
            out.insert(out.end(), pkt.begin(), pkt.end());
        }
        return out;
    };
    std::vector<std::pair<int, VideoInfo>> vi_events;
    SplitterCallbacks cb_v;
    cb_v.on_videoinfo = [&](int pid, const VideoInfo& info) {
        vi_events.push_back({pid, info});
    };
    SplitterCore core_v(1, {{VIDEO_PID, -1}}, cb_v);
    Bytes vsrc;
    {
        uint8_t tmp[PKT];
        build_pat(7, {{1, PMT_PID}}, 0, 0, tmp);
        append_pkt(vsrc, tmp);
        build_pmt(PMT_PID, 1, VIDEO_PID,
                  {{VIDEO_PID, STREAM_TYPE_AVC, {}}, {AUDIO_PID, STREAM_TYPE_AAC, {}}}, 0, 0,
                  tmp);
        append_pkt(vsrc, tmp);
    }
    core_v.feed(vsrc.data(), vsrc.size());       // PMT parses -> probe created
    Bytes vp = video_pes_pkts(VIDEO_PID, 0);
    core_v.feed(vp.data(), vp.size());
    CHECK("on_videoinfo fires with pid + geometry",
          vi_events.size() == 1 && vi_events[0].first == VIDEO_PID &&
              vi_events[0].second.width == 1920 && vi_events[0].second.interlaced &&
              *vi_events[0].second.interlaced);
    Bytes vp2 = video_pes_pkts(VIDEO_PID, 4);
    core_v.feed(vp2.data(), vp2.size());
    CHECK("on_videoinfo silent on unchanged SPS", vi_events.size() == 1);

    // Audio-only PMT -> no probe, never fires.
    std::vector<int> vi_a;
    SplitterCallbacks cb_a;
    cb_a.on_videoinfo = [&](int pid, const VideoInfo&) { vi_a.push_back(pid); };
    SplitterCore core_a(1, {{AUDIO_PID, -1}}, cb_a);
    Bytes asrc;
    {
        uint8_t tmp[PKT];
        build_pat(7, {{1, PMT_PID}}, 0, 0, tmp);
        append_pkt(asrc, tmp);
        build_pmt(PMT_PID, 1, AUDIO_PID, {{AUDIO_PID, STREAM_TYPE_AAC, {}}}, 0, 0, tmp);
        append_pkt(asrc, tmp);
        Bytes ap = video_pes_pkts(AUDIO_PID, 0);
        asrc.insert(asrc.end(), ap.begin(), ap.end());
    }
    core_a.feed(asrc.data(), asrc.size());
    CHECK("audio-only PMT never fires on_videoinfo", vi_a.empty());

    return test_summary("ts_split");
}
