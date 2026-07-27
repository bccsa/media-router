#include "ts_split.h"

#include <cstring>

namespace mrts {

void SplitOutput::update(int stype, const std::vector<uint8_t>& info) {
    if (stype == stream_type && info == es_info) return;
    stream_type = stype;
    es_info = info;
    version = (version + 1) & 0x1F;
    since_psi = SPLIT_PSI_INTERVAL_PKTS;
}

void SplitOutput::batch(const uint8_t* const* chunks, size_t count,
                        int64_t master_pcr, std::vector<uint8_t>& out) {
    out.clear();
    uint8_t tmp[PKT];
    since_psi += (int)count;
    if (since_psi >= SPLIT_PSI_INTERVAL_PKTS) {
        build_pat(ts_id, {{1, SPLIT_PMT_PID}}, cc_pat, 0, tmp);
        cc_pat = (cc_pat + 1) & 0x0F;
        out.insert(out.end(), tmp, tmp + PKT);
        build_pmt(SPLIT_PMT_PID, 1, pid, {{pid, stream_type, es_info}}, cc_pmt,
                  version, tmp);
        cc_pmt = (cc_pmt + 1) & 0x0F;
        out.insert(out.end(), tmp, tmp + PKT);
        since_psi = 0;
    }
    if (needs_pcr && master_pcr >= 0 && master_pcr != last_pcr &&
        (last_pcr < 0 ||
         ((master_pcr - last_pcr) % PCR_MODULO + PCR_MODULO) % PCR_MODULO >=
             SPLIT_PCR_MIN_TICKS)) {
        build_pcr_packet(pid, master_pcr, last_cc, tmp);
        out.insert(out.end(), tmp, tmp + PKT);
        last_pcr = master_pcr;
    }
    for (size_t i = 0; i < count; i++)
        out.insert(out.end(), chunks[i], chunks[i] + PKT);
    last_cc = chunks[count - 1][3] & 0x0F;
}

SplitterCore::SplitterCore(int ts_id, const std::vector<OutputSpec>& outputs,
                           SplitterCallbacks callbacks)
    : ts_id_(ts_id), cb_(std::move(callbacks)) {
    std::memset(out_lut_, -1, sizeof out_lut_);
    std::memset(probe_lut_, -1, sizeof probe_lut_);
    for (const auto& spec : outputs) {
        out_lut_[spec.pid & 0x1FFF] = (int16_t)outputs_.size();
        outputs_.emplace_back(spec.pid, ts_id,
                              spec.stream_type >= 0 ? spec.stream_type
                                                    : STREAM_TYPE_AVC);
    }
    enabled_.assign(outputs_.size(), true);
    buckets_.resize(outputs_.size());
    batch_bufs_.resize(outputs_.size());
}

bool SplitterCore::add_output(int pid, int stream_type) {
    if (pid < 0 || pid > 0x1FFF) return false;
    if (out_lut_[pid] >= 0) return false;        // already an output
    out_lut_[pid] = (int16_t)outputs_.size();
    outputs_.emplace_back(pid, ts_id_,
                          stream_type >= 0 ? stream_type : STREAM_TYPE_AVC);
    enabled_.push_back(false);                   // gated until an edge attaches
    buckets_.emplace_back();
    batch_bufs_.emplace_back();
    // Adopt whatever the source PMT already told us about this PID (the
    // caller learned the pid FROM discovery, so this is the common case).
    if (disc_.pmt()) {
        const PmtStream* match = nullptr;
        for (const auto& s : disc_.pmt()->streams)
            if (s.pid == pid) match = &s;        // last entry wins (python parity)
        if (match) outputs_.back().update(match->stream_type, match->es_info);
        outputs_.back().needs_pcr = pid != pcr_pid_;
    }
    return true;
}

void SplitterCore::set_enabled(const std::vector<int>& pids) {
    std::vector<bool> next(outputs_.size(), false);
    for (int pid : pids) {
        int16_t idx = out_lut_[pid & 0x1FFF];
        if (idx >= 0) next[idx] = true;
    }
    for (size_t i = 0; i < outputs_.size(); i++) {
        if (next[i] && !enabled_[i]) {
            // Transition to enabled: force PSI + PCR so a fresh consumer
            // locks on the very first batch.
            outputs_[i].since_psi = SPLIT_PSI_INTERVAL_PKTS;
            outputs_[i].last_pcr = -1;
        }
    }
    enabled_ = std::move(next);
}

void SplitterCore::apply_discovery() {
    const Pmt& pmt = *disc_.pmt();
    pcr_pid_ = pmt.pcr_pid;
    for (auto& o : outputs_) {
        const PmtStream* match = nullptr;   // last entry wins (python dict parity)
        for (const auto& s : pmt.streams)
            if (s.pid == o.pid) match = &s;
        if (match) o.update(match->stream_type, match->es_info);
        o.needs_pcr = o.pid != pcr_pid_;
    }
    // SPS probes for the PMT's video PIDs (status reporting). Kept across
    // unrelated PMT changes; a codec change replaces the probe.
    std::vector<VideoInfoProbe> next;
    std::memset(probe_lut_, -1, sizeof probe_lut_);
    for (const auto& s : pmt.streams) {
        if (s.stream_type != STREAM_TYPE_AVC && s.stream_type != STREAM_TYPE_HEVC)
            continue;
        bool h265 = s.stream_type == STREAM_TYPE_HEVC;
        bool kept = false;
        for (auto& old : probes_)
            if (old.pid == s.pid && old.h265 == h265) {
                next.push_back(std::move(old));
                kept = true;
                break;
            }
        if (!kept) next.emplace_back(s.pid, h265);
        probe_lut_[s.pid & 0x1FFF] = (int16_t)(next.size() - 1);
    }
    probes_ = std::move(next);
    if (cb_.on_discovered) {
        std::vector<std::pair<int, int>> streams;
        std::vector<std::pair<int, std::vector<uint8_t>>> es_info;
        for (const auto& s : pmt.streams) {
            streams.push_back({s.pid, s.stream_type});
            es_info.push_back({s.pid, s.es_info});
        }
        cb_.on_discovered(streams, pcr_pid_, es_info);
    }
}

const std::vector<SplitterCore::Batch>& SplitterCore::feed(const uint8_t* data,
                                                           size_t len) {
    if (!rem_.empty()) {
        joined_.clear();
        joined_.insert(joined_.end(), rem_.begin(), rem_.end());
        joined_.insert(joined_.end(), data, data + len);
        rem_.clear();
        data = joined_.data();
        len = joined_.size();
    }
    const long n = (long)len;
    long off = 0;
    long long desynced = 0;
    for (auto& b : buckets_) b.clear();
    psi_pkts_.clear();
    result_.clear();
    const int pmt_pid_before = disc_.pmt_pid();
    const int pcr_pid = pcr_pid_;
    std::vector<int> used;           // bucket indexes, first-appearance order
    while (off + PKT <= n) {
        const uint8_t* p = data + off;
        if (p[0] != SYNC_BYTE) {
            // Lost sync: scan for a sync byte confirmed by another sync one
            // packet later (or by the buffer edge), drop the garbage span.
            long scan = off + 1;
            while (scan + PKT <= n &&
                   !(data[scan] == SYNC_BYTE &&
                     (scan + 2 * PKT > n || data[scan + PKT] == SYNC_BYTE)))
                scan++;
            desynced += scan - off;
            off = scan;
            continue;
        }
        int pid = ((p[1] & 0x1F) << 8) | p[2];
        int16_t oi = out_lut_[pid];
        if (oi >= 0 && enabled_[oi]) {
            if (buckets_[oi].empty()) used.push_back(oi);
            buckets_[oi].push_back(p);
        }
        int16_t pi = probe_lut_[pid];
        if (pi >= 0) {
            auto info = probes_[pi].feed(p);
            if (info && cb_.on_videoinfo) cb_.on_videoinfo(pid, *info);
        }
        if (pid == PID_PAT || (pmt_pid_before >= 0 && pid == pmt_pid_before)) {
            psi_pkts_.emplace_back();
            std::memcpy(psi_pkts_.back().b, p, PKT);   // discovery retains these
        }
        if (pid == pcr_pid) {
            int64_t v = read_pcr(p);
            if (v >= 0) master_pcr_ = v;
        }
        off += PKT;
    }
    // Remainder = wherever the pass actually stopped (a desync can leave the
    // tail unaligned — never pre-compute this from len alone).
    if (off < n) rem_.assign(data + off, data + n);
    if (desynced) {
        desync_bytes_ += desynced;
        if (cb_.on_desync) cb_.on_desync(desynced);
    }
    // Feed discovery every call (empty is fine): its call count drives the
    // periodic PMT re-parse.
    if (disc_.feed(psi_pkts_)) apply_discovery();
    if (pmt_pid_before < 0 && disc_.pmt_pid() >= 0) {
        // The PAT parsed from THIS buffer — its PMT packets are typically in
        // the same buffer and were not captured above. One targeted re-scan,
        // once per stream lifetime.
        const int new_pid = disc_.pmt_pid();
        std::vector<TsPacket> late;
        for (long o = 0; o + PKT <= (n / PKT) * PKT; o += PKT) {
            if (data[o] == SYNC_BYTE && ts_pid(data + o) == new_pid) {
                late.emplace_back();
                std::memcpy(late.back().b, data + o, PKT);
            }
        }
        if (!late.empty() && disc_.feed(late)) apply_discovery();
    }
    const int64_t master = master_pcr_;
    for (int oi : used) {
        outputs_[oi].batch(buckets_[oi].data(), buckets_[oi].size(), master,
                           batch_bufs_[oi]);
        result_.push_back({outputs_[oi].pid, &batch_bufs_[oi]});
    }
    return result_;
}

}  // namespace mrts
