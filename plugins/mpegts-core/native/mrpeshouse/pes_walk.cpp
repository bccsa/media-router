// PesStamper.feed, rule for rule (subtitle_ts.py). Python's slices clamp at
// the packet end; the explicit bounds below do the same.
#include "pes_walk.h"

#include "mrts/ts_psi.h"

namespace mrpeshouse {

namespace {

// Payload offset as python's `payload_offset`: PKT when the packet has none.
int payload_offset(const uint8_t* pkt) {
    if (!mrts::ts_has_payload(pkt)) return mrts::PKT;
    int off = mrts::payload_offset(pkt);
    return off < mrts::PKT ? off : mrts::PKT;
}

bool no_header_id(int sid) {
    switch (sid) {
        case 0xBC: case 0xBE: case 0xBF: case 0xF0:
        case 0xF1: case 0xF2: case 0xF8: case 0xFF:
            return true;
        default:
            return false;
    }
}

}  // namespace

std::optional<PesHeader> parse_pes_header(const uint8_t* pkt, int off) {
    const uint8_t* p = pkt + off;
    const int n = mrts::PKT - off;
    if (n < 9 || p[0] != 0 || p[1] != 0 || p[2] != 1) return std::nullopt;
    const int sid = p[3];
    if (no_header_id(sid) || (p[6] & 0xC0) != 0x80) return std::nullopt;
    const int hdr = 9 + p[8];
    // mrts reads the PTS under the same header checks; it needs 14 bytes.
    const int64_t pts = (p[7] & 0x80) && n >= 14 ? mrts::read_pes_pts(pkt) : -1;
    const int64_t plen = (p[4] << 8) | p[5];
    const int64_t need = plen && 6 + plen >= hdr ? 6 + plen - hdr : -1;
    return PesHeader{sid, pts, hdr, need};
}

void PesWalker::add(int pid, const Rec& rec, const uint8_t* p, size_t n,
                    std::vector<std::pair<int, Rec>>& done) {
    rec->buf.insert(rec->buf.end(), p, p + n);
    if (rec->need >= 0 && rec->buf.size() >= (size_t)rec->need) {
        rec->buf.resize((size_t)rec->need);
        open_.erase(pid);
        done.emplace_back(pid, rec);
    } else if (rec->buf.size() > MAX_PES_BYTES) {
        open_.erase(pid);               // lost its end: drop, never grow
    }
}

std::vector<DonePes> PesWalker::feed(const uint8_t* data, size_t len, std::optional<double> chunk_ms) {
    std::vector<std::pair<int, Rec>> done;
    std::vector<Rec> started;
    std::vector<Head> heads;
    for (size_t i = 0; i + mrts::PKT <= len; i += mrts::PKT) {
        const uint8_t* pkt = data + i;
        if (pkt[0] != mrts::SYNC_BYTE) continue;
        const int pid = mrts::ts_pid(pkt);
        if (mrts::read_pcr(pkt) >= 0) pcr_pid_ = pid;
        const int off = payload_offset(pkt);
        if (off >= mrts::PKT) continue;
        if (!mrts::ts_pusi(pkt)) {
            auto it = open_.find(pid);
            if (it != open_.end()) {
                Rec rec = it->second;
                add(pid, rec, pkt + off, mrts::PKT - off, done);
            }
            continue;
        }
        std::optional<PesHeader> h = parse_pes_header(pkt, off);
        if (!h) continue;
        auto prev = open_.find(pid);
        if (prev != open_.end()) {
            if (prev->second->need < 0) done.emplace_back(pid, prev->second);  // unbounded: ends here
            open_.erase(prev);
        }
        if (h->pts >= 0) heads.push_back({pid, h->sid, h->pts});
        if (h->sid != sid_ || (pids_ && !pids_->count(pid))) continue;
        Rec rec = std::make_shared<Open>(Open{h->pts, std::nullopt, {}, h->need});
        open_[pid] = rec;
        started.push_back(rec);
        const int body = off + h->header_len;
        add(pid, rec, pkt + (body < mrts::PKT ? body : mrts::PKT),
            body < mrts::PKT ? mrts::PKT - body : 0, done);
    }
    Reference ref = chunk_reference(heads, pcr_pid_);
    model_.observe(chunk_ms, ref.pts, ref.sure);
    for (const Rec& rec : started)
        rec->house_ms = model_.house(rec->pts >= 0 ? std::optional<int64_t>(rec->pts) : std::nullopt);
    std::vector<DonePes> out;
    out.reserve(done.size());
    for (auto& [pid, rec] : done) out.push_back({pid, rec->pts, rec->buf, rec->house_ms});
    return out;
}

}  // namespace mrpeshouse
