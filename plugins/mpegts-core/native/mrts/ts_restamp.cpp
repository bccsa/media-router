#include "ts_restamp.h"

#include <algorithm>
#include <climits>
#include <cstring>

namespace mrts {
namespace {

int64_t floor_mod(int64_t a, int64_t m) {
    const int64_t r = a % m;
    return r < 0 ? r + m : r;
}

int64_t clamp64(int64_t v, int64_t lo, int64_t hi) { return v < lo ? lo : v > hi ? hi : v; }

// The longer of two, the middle of three.
int64_t upper_median(const int64_t* s, int n) {
    return n == 2 ? std::max(s[0], s[1]) : std::max(std::min(s[0], s[1]), std::min(std::max(s[0], s[1]), s[2]));
}

constexpr uint32_t fourcc(const char (&s)[5]) {
    return ((uint32_t)(uint8_t)s[0] << 24) | ((uint32_t)(uint8_t)s[1] << 16) |
           ((uint32_t)(uint8_t)s[2] << 8) | (uint8_t)s[3];
}

// The walker hands a packet split across feeds from its own buffer: such a packet
// leaves as a copy, every other one in place.
bool inside(const uint8_t* p, const uint8_t* base, size_t len) {
    const uintptr_t a = (uintptr_t)p, b = (uintptr_t)base;
    return a >= b && a - b + PKT <= len;
}

// A dropped packet that carries the PCR stays, adaptation only: the PCR's cadence
// is the program's, not the PES's. PUSI and random_access_indicator go with the
// payload (the PES the indicator announced is the one removed).
void to_af_only(uint8_t* pkt, uint8_t cc) {
    const int af = std::min<int>(pkt[4], PKT - 5);
    pkt[1] &= (uint8_t)~0x40;
    pkt[5] &= (uint8_t)~0x40;
    pkt[3] = (uint8_t)((pkt[3] & 0xC0) | 0x20 | (cc & 0x0F));
    std::memset(pkt + 5 + af, 0xFF, (size_t)(PKT - 5 - af));
    pkt[4] = PKT - 5;
}

RestampCore::Event make_event(RestampCore::Event::Kind k, int program, int pid, const char* reason,
                              int64_t house_ns, uint32_t epoch) {
    RestampCore::Event e;
    e.kind = k;
    e.program = program;
    e.pid = pid;
    e.reason = reason;
    e.house_ns = house_ns;
    e.epoch = epoch;
    return e;
}

}  // namespace

StreamClass stream_class(int stream_type, const std::vector<uint8_t>& es_info) {
    switch (stream_type) {
        case 0x01: case 0x02: case 0x10: case 0x1B: case 0x20: case 0x24: case 0x33:
        case 0x42: case 0xD1: case 0xEA:
            return StreamClass::video;
        case 0x03: case 0x04: case 0x0F: case 0x11: case 0x1C: case 0x81: case 0x87:
            return StreamClass::audio;
        case STREAM_TYPE_PRIVATE_PES:
            break;
        default:
            return StreamClass::other;
    }
    switch (registration_format(es_info)) {
        case fourcc("BSSD"): case fourcc("Opus"): case fourcc("AC-3"): case fourcc("EAC3"):
        case fourcc("DTS1"): case fourcc("DTS2"): case fourcc("DTS3"):
            return StreamClass::audio;
        case fourcc("HEVC"): case fourcc("AV01"):
            return StreamClass::video;
        default:
            break;
    }
    static const uint8_t kAudioTags[] = {0x6A, 0x7A, 0x7B, 0x7C};   // DVB AC-3, E-AC-3, DTS, AAC
    for (uint8_t tag : kAudioTags)
        if (has_descriptor(es_info, tag)) return StreamClass::audio;
    return StreamClass::other;
}

const char* event_kind_name(RestampCore::Event::Kind k) {
    switch (k) {
        case RestampCore::Event::Kind::relock: return "relock";
        case RestampCore::Event::Kind::degraded: return "degraded";
        case RestampCore::Event::Kind::recovered: return "recovered";
        case RestampCore::Event::Kind::envelope_step: return "envelope-step";
        case RestampCore::Event::Kind::gap: return "gap";
        case RestampCore::Event::Kind::overlap: return "overlap";
        case RestampCore::Event::Kind::lead_clamp: return "lead-clamp";
        default: return "psi-change";
    }
}

size_t RestampCore::Result::bytes() const {
    size_t n = 0;
    for (const Range& r : keep) n += r.len;
    return n;
}

RestampCore::RestampCore(const RestampConfig& cfg) : cfg_(cfg), pids_(8192), pmt_ref_(8192, 0) {
    base_ = cfg.mode == RestampConfig::Mode::fixed && cfg.add_base_time ? cfg.base_time_ns : 0;
    set_offset(cfg.offset_ns);
    set_trims(cfg.trims_ns);
}

void RestampCore::set_offset(int64_t ns) {
    offset_ = clamp64(ns, -OFFSET_LIMIT_NS, OFFSET_LIMIT_NS);
    for (auto& g : progs_) update_pcr_shift(*g);
}

void RestampCore::set_trims(const std::map<int, int64_t>& trims_ns) {
    trims_.clear();
    for (const auto& t : trims_ns)
        if (t.second != 0) trims_[t.first] = clamp64(t.second, -TRIM_LIMIT_NS, TRIM_LIMIT_NS);
    for (auto& g : progs_) update_pcr_shift(*g);
}

int64_t RestampCore::target_shift(int pid) const {
    const auto it = trims_.find(pid);
    return offset_ + (it == trims_.end() ? 0 : it->second);
}

void RestampCore::update_pcr_shift(Program& g) {
    // The PCR follows min(0, smallest shift), so PTS - PCR never shrinks below the
    // source's own lead; a shift still on its way to a PID counts already.
    int64_t m = 0;
    for (int pid : g.es) {
        const Pid* p = pids_[pid].get();
        if (!p) continue;
        const int64_t t = target_shift(pid);
        m = std::min({m, t, p->have_last ? p->shift : t});
    }
    if (m != g.pcr_shift) {
        g.pcr_shift = m;
        g.flag_pcr = true;
    }
}

RestampCore::Result RestampCore::process(uint8_t* data, size_t len, int64_t arrival_ns) {
    Result res;
    res_ = &res;
    in_ = data;
    in_len_ = len;
    ops_.clear();
    scratch_.clear();
    out_bytes_ = 0;
    const int64_t silence = have_arrival_ ? arrival_ns - arrival_ : 0;
    have_arrival_ = true;
    arrival_ = arrival_ns;
    arrival_h_ = arrival_ns + base_;
    if (silence >= OUTAGE_NS) {
        // Not a re-lock by itself (part 4.4): each PID's PES are checked for the gap
        // it left, from this buffer on (which may still carry content from before it).
        for (auto& p : pids_)
            if (p) p->outage = true;
        for (auto& g : progs_) g->flag_pcr = true;   // a gap of 1 s or more in everything
        outage_h_ = arrival_h_;
        record(TraceKind::outage, PID_NULL, (uint64_t)silence, 0, 0, arrival_ns);
    }
    walker_.feed(data, len, [this](PacketView& v) { on_packet(v); });
    for (const Op& o : ops_)
        res.keep.push_back(Range{(o.internal ? scratch_.data() : data) + o.off, o.len});
    res.in_place = ops_.empty() ? len == 0
                                : ops_.size() == 1 && !ops_[0].internal && ops_[0].off == 0 &&
                                      ops_[0].len == len;
    res_ = nullptr;
    return res;
}

void RestampCore::put(const uint8_t* pkt) {
    const bool internal = !inside(pkt, in_, in_len_);
    size_t off;
    if (internal) {
        off = scratch_.size();
        scratch_.insert(scratch_.end(), pkt, pkt + PKT);
    } else {
        off = (size_t)(pkt - in_);
    }
    if (!ops_.empty() && ops_.back().internal == internal && ops_.back().off + ops_.back().len == off)
        ops_.back().len += PKT;
    else
        ops_.push_back(Op{internal, off, (size_t)PKT});
    out_bytes_ += PKT;
}

void RestampCore::on_packet(PacketView& v) {
    const CcTracker::Result cc = cc_in_.feed(v);
    if (v.pid == PID_PAT || pmt_ref_[v.pid]) {
        on_psi(v);
        put(v.p);
        return;
    }
    Pid* p = pids_[v.pid].get();
    if (!p) {
        // Null packets and the SI tables (PIDs below 0x20) carry no PES time; any
        // other PID no PMT lists (yet) has no program whose clock could place it.
        if (v.pid == PID_NULL || v.pid < 0x20) put(v.p);
        else unknown_++;
        return;
    }
    const bool di = v.af_discontinuity;   // the source's: on_pcr may flag this packet
    if (v.af_pcr) on_pcr(*p, v);
    if (p->stream_type < 0) {             // the PCR PID alone: no PES, nothing removed
        put(v.p);
        return;
    }
    on_es(*p, v, cc, di);
}

void RestampCore::on_psi(const PacketView& v) {
    TsPacket pk;
    std::memcpy(pk.b, v.p, PKT);
    if (v.pid == PID_PAT) {
        // PsiDiscovery follows one program, so the PAT is read here too: every
        // program it lists gets its own discovery and clock.
        SectionSig sig;
        if (section_signature(v.p, &sig) && sig.table_id == TABLE_PAT && !(sig == pat_sig_)) {
            pat_pkts_.clear();
            pat_sig_ = sig;
        }
        pat_pkts_.push_back(pk);
        if (pat_pkts_.size() > 16) pat_pkts_.pop_front();
        const std::vector<std::pair<int, int>> pat = parse_pat(pat_pkts_);
        if (!pat.empty() && pat != pat_) update_programs(pat);
    }
    const std::vector<TsPacket> one(1, pk);
    for (auto& g : progs_) {
        g->psi.feed(one);
        if (g->psi.generation() != g->gen) rebuild(*g);
    }
}

void RestampCore::update_programs(const std::vector<std::pair<int, int>>& pat) {
    pat_ = pat;
    for (size_t i = 0; i < progs_.size();) {
        Program& g = *progs_[i];
        const auto it = std::find_if(pat.begin(), pat.end(),
                                     [&](const std::pair<int, int>& e) { return e.first == g.number; });
        if (it == pat.end()) {
            for (auto& p : pids_)
                if (p && p->prog == &g) p.reset();
            progs_.erase(progs_.begin() + (std::ptrdiff_t)i);
            continue;
        }
        g.pmt_pid = it->second;
        i++;
    }
    for (const auto& e : pat) {
        const bool known = std::any_of(progs_.begin(), progs_.end(),
                                       [&](const std::unique_ptr<Program>& g) { return g->number == e.first; });
        if (!known) progs_.push_back(std::make_unique<Program>(e.first, e.second, cfg_));
    }
    std::fill(pmt_ref_.begin(), pmt_ref_.end(), 0);
    for (auto& g : progs_) pmt_ref_[g->pmt_pid & 0x1FFF]++;
    events_.push_back(make_event(Event::Kind::psi_change, -1, -1, "pat", arrival_h_, 0));
}

RestampCore::Pid* RestampCore::pid_entry(int pid, Program& g) {
    std::unique_ptr<Pid>& slot = pids_[pid];
    if (slot) return slot->prog == &g ? slot.get() : nullptr;   // a PID of two programs: the first's
    slot = std::make_unique<Pid>();
    slot->pid = pid;
    slot->prog = &g;
    slot->shift = target_shift(pid);
    return slot.get();
}

void RestampCore::rebuild(Program& g) {
    const bool first = g.gen == 0;
    g.gen = g.psi.generation();
    const std::optional<Pmt>& pmt = g.psi.pmt();
    if (!pmt) return;
    const int old_pcr = g.pcr_pid;
    // PIDs the table still lists keep their timing state (guard, CC, unwrap).
    for (auto& p : pids_)
        if (p && p->prog == &g) p->stream_type = -2;
    g.es.clear();
    for (const PmtStream& s : pmt->streams) {
        if (s.pid == PID_PAT || s.pid >= PID_NULL || pmt_ref_[s.pid]) continue;   // never PSI
        Pid* p = pid_entry(s.pid, g);
        if (!p) continue;
        p->stream_type = s.stream_type;
        p->cls = stream_class(s.stream_type, s.es_info);
        g.es.push_back(s.pid);
    }
    g.pcr_pid = -1;
    if (pmt->pcr_pid > PID_PAT && pmt->pcr_pid < PID_NULL && !pmt_ref_[pmt->pcr_pid]) {
        Pid* p = pid_entry(pmt->pcr_pid, g);
        if (p) {
            g.pcr_pid = pmt->pcr_pid;
            if (p->stream_type == -2) p->stream_type = -1;
        }
    }
    for (auto& p : pids_)
        if (p && p->prog == &g && p->stream_type == -2) p.reset();
    // Degraded mode's reference (part 4.3): the PCR PID if it carries PES, else the
    // first video, else the first audio PID.
    g.ref_pid = g.pcr_pid >= 0 && pids_[g.pcr_pid]->stream_type >= 0 ? g.pcr_pid : -1;
    for (StreamClass c : {StreamClass::video, StreamClass::audio})
        for (int pid : g.es)
            if (g.ref_pid < 0 && pids_[pid]->cls == c) g.ref_pid = pid;
    const bool pcr_moved = !first && old_pcr != g.pcr_pid;
    if (pcr_moved && cfg_.mode == RestampConfig::Mode::stc) {
        g.stc.relock();                   // a re-lock trigger (part 4.4): the next PCR opens an epoch
        pull_events(g);
    }
    update_pcr_shift(g);
    events_.push_back(make_event(Event::Kind::psi_change, g.number, -1, pcr_moved ? "pcr-pid" : "pmt",
                                 arrival_h_, 0));
    record_psi(g);
}

void RestampCore::record_psi(const Program& g) {
    if (!trace_ || !g.psi.pmt()) return;
    record(TraceKind::psi, g.pcr_pid >= 0 ? g.pcr_pid : PID_NULL, trace_psi_value(g.number, 0, true), 0, 0,
           arrival_);
    for (int pid : g.es) {
        const Pid& q = *pids_[pid];
        record(TraceKind::psi, pid, trace_psi_value(g.number, q.stream_type, false), 0, trace_flags(false, q.cls),
               arrival_);
    }
}

void RestampCore::set_trace(TraceWriter* w) {
    // A trace begun mid-stream opens with the tables in force, so it replays on its own.
    trace_ = w;
    for (const auto& g : progs_) record_psi(*g);
}

void RestampCore::pull_events(Program& g) {
    for (const StcEvent& e : g.stc.take_events()) {
        Event out = make_event(Event::Kind::relock, g.number, -1, e.reason, e.house_ns, e.epoch);
        switch (e.kind) {
            case StcEvent::Kind::leap:
                g.pending_leap = e.value_ns;   // told with the relock it causes
                continue;
            case StcEvent::Kind::relock:
                if (!std::strcmp(e.reason, "leap")) out.value_ns = g.pending_leap;
                g.flag_pcr = true;        // a new epoch: the PCR's timeline breaks
                break;
            case StcEvent::Kind::degraded:
                out.kind = Event::Kind::degraded;
                out.pid = g.ref_pid;      // the warning names the PID whose PTS times the program
                g.degraded = true;
                break;
            case StcEvent::Kind::recovered:
                out.kind = Event::Kind::recovered;
                g.degraded = false;
                break;
            case StcEvent::Kind::envelope_step:
                out.kind = Event::Kind::envelope_step;
                out.value_ns = e.value_ns;
                break;
            case StcEvent::Kind::lead_clamp:
                out.kind = Event::Kind::lead_clamp;
                out.pid = e.pid;
                out.value_ns = e.value_ns;
                break;
        }
        events_.push_back(out);
    }
}

void RestampCore::record(TraceKind k, int pid, uint64_t value, int32_t d, uint8_t flags, int64_t arrival) {
    if (!trace_) return;
    TraceRecord r;
    r.arrival_ns = arrival;
    r.value = value;
    r.pid = (uint16_t)pid;
    r.kind = k;
    r.flags = flags;
    r.dts_minus_pts_90k = d;
    trace_->write(r);
}

void RestampCore::on_pcr(Pid& p, PacketView& v) {
    Program& g = *p.prog;
    const int64_t pcr = read_pcr(v.p);
    if (v.pid != g.pcr_pid) {
        // A PCR field off the PCR PID clocks nothing, but must not carry source time:
        // it moves as the PCR PID's last one did.
        write_pcr(v, floor_mod(pcr + g.pcr_off27, PCR_MODULO));
        return;
    }
    record(TraceKind::pcr, v.pid, (uint64_t)pcr, 0, trace_flags(v.af_discontinuity, p.cls), arrival_);
    int64_t out27, out_ns = 0;
    bool regen = false;
    uint32_t epoch = 0;
    if (cfg_.mode == RestampConfig::Mode::fixed) {
        // Moved by the constant the PES move by: PTS - PCR stays the mux's, exactly.
        out27 = floor_mod(pcr + ns_to_pts90k(base_ + g.pcr_shift) * 300, PCR_MODULO);
    } else {
        const bool first = !g.have_pcr;
        g.stc.feed_pcr(pcr, v.af_discontinuity, arrival_);
        g.have_pcr = true;
        // PES before the first PCR were unwrapped against no clock: re-seed on it.
        if (first)
            for (int pid : g.es)
                if (pids_[pid]) pids_[pid]->unwrap.reset();
        pull_events(g);
        // The one mapping its PES take, epoch choice included, outside the lead row.
        VirtualStc::Mapping m;
        if (!g.degraded) {
            m = g.stc.map_pcr(arrival_);
            pull_events(g);
        }
        if (m.valid) {
            out_ns = m.house_ns + g.pcr_shift;
            epoch = m.epoch;
        } else if (m.stale) {
            // No PES leaves while the line is a backlog's (B-39): the PCR keeps arrival's pace
            // (a frozen one would read as a freeze one hop on), never back among such.
            out_ns = arrival_h_ - DEGRADED_PCR_LEAD_NS;
            if (g.have_wpcr && g.wpcr_regen && out_ns < g.wpcr_ns) out_ns = g.wpcr_ns;
            regen = true;
        } else {
            out_ns = degraded_pcr(g);
            regen = true;
        }
        // Written as mpegtsmux writes its PCR, on the PTS's base (house + 1 h), so
        // PTS - PCR on the bus is the source's lead.
        out27 = floor_mod(ns_to_pcr27(out_ns) + MUX_CLOCK_BASE_90K * 300, PCR_MODULO);
    }
    // Phases 1-2's tsdemux re-bases at every flagged PCR, so only a break is flagged: flag_pcr (a shift,
    // a relock, an outage, a PES gap of 1 s or more), mapped <-> regenerated, another epoch's line, a
    // step back (a line moved onto its floor). A sparse PCR's own spacing is none (B-84).
    int64_t step = floor_mod(out27 - g.wpcr27, PCR_MODULO);
    if (step > PCR_MODULO / 2) step -= PCR_MODULO;
    if (g.have_wpcr && (g.flag_pcr || regen != g.wpcr_regen || epoch != g.wpcr_epoch || step < 0))
        set_discontinuity_indicator(v);
    g.flag_pcr = false;
    write_pcr(v, out27);
    g.pcr_off27 = floor_mod(out27 - pcr, PCR_MODULO);
    g.have_wpcr = true;
    g.wpcr_regen = regen;
    g.wpcr_ns = out_ns;
    g.wpcr27 = out27;
    g.wpcr_epoch = epoch;
}

int64_t RestampCore::degraded_pcr(const Program& g) const {
    // The conditioner's rule (part 4.3): the reference PID's last written key, pulled
    // down by a recent video/audio PID up to 1 s behind it, minus 250 ms; never back
    // among regenerated values. Keys are decode order, so B-frames do not jitter it.
    const Pid* ref = g.ref_pid >= 0 ? pids_[g.ref_pid].get() : nullptr;
    bool have = ref && ref->have_last;
    int64_t floor = have ? ref->last_key : 0;
    for (int pid : g.es) {
        const Pid* p = pids_[pid].get();
        if (!p || p == ref || !p->have_last || p->cls == StreamClass::other ||
            arrival_h_ - p->last_h > DEGRADED_RECENT_NS)
            continue;
        if (!have) {
            floor = p->last_key;
            have = true;
        } else if (p->last_key < floor && floor - p->last_key <= DEGRADED_FLOOR_NS) {
            floor = p->last_key;
        }
    }
    int64_t w = have ? floor - DEGRADED_PCR_LEAD_NS
                     : g.have_wpcr ? g.wpcr_ns : arrival_h_ - DEGRADED_PCR_LEAD_NS;
    if (g.have_wpcr && g.wpcr_regen && w < g.wpcr_ns) w = g.wpcr_ns;
    return w;
}

void RestampCore::keep_es(Pid& p, uint8_t* pkt, bool span_cont) {
    // Once packets of a PID were removed, its later ones are renumbered so the
    // output's CC stays continuous (part 4.2 step 5).
    if (p.cc_delta) pkt[3] = (uint8_t)((pkt[3] & 0xF0) | (((pkt[3] & 0x0F) - p.cc_delta) & 0x0F));
    if (pkt[3] & 0x10) {
        p.emitted = p.seen_payload = p.prev_kept = true;
        p.prev_cont = span_cont;
        p.out_cc = pkt[3] & 0x0F;
    }
    put(pkt);
}

void RestampCore::drop_es(Pid& p, uint8_t* pkt, bool duplicate) {
    if (pkt[3] & 0x10) {
        p.seen_payload = true;
        p.prev_kept = false;
        // A removed step shifts what follows; before the PID's first payload left there
        // is no continuity to keep, and a duplicate is no step.
        if (p.emitted && !duplicate) p.cc_delta = (uint8_t)((p.cc_delta + 1) & 0x0F);
    }
    if (read_pcr(pkt) >= 0) {
        to_af_only(pkt, (uint8_t)((pkt[3] & 0x0F) - p.cc_delta));
        pcr_kept_++;
        put(pkt);
        return;
    }
    removed_++;
}

void RestampCore::release_held_af(Pid& p) {
    for (size_t i = 0; i + PKT <= p.held_af.size(); i += PKT) keep_es(p, p.held_af.data() + i);
    p.held_af.clear();
}

void RestampCore::on_es(Pid& p, PacketView& v, CcTracker::Result cc, bool di) {
    const bool payload = v.payload_off < PKT;
    const bool dup = cc == CcTracker::Result::Duplicate;
    if (payload && span_.held(v.pid)) {
        if (dup && v.pusi) {
            // A copy of the held packet (2.4.3.3): the decoder keeps the first, which
            // waits for its continuation, so the copy alone goes.
            drop_es(p, v.p, true);
            return;
        }
        // A header held for this PID's next payload packet: rewritten across both,
        // released in order (other PIDs passed meanwhile).
        uint8_t first[PKT];
        bool joined = false, keep = false;
        span_.complete(v, first, [&](const PesHeader& h, int64_t& pts33, int64_t& dts33) {
            joined = true;
            keep = start_pes(p, h, p.held_h, p.held_di, pts33, dts33);
        });
        if (joined) {
            if (keep) {
                keep_es(p, first);
                keep_es(p, v.p, true);
            } else {
                drop_es(p, first, false);
                drop_es(p, v.p, false);
            }
            release_held_af(p);
            return;
        }
        // Not joinable (a CC gap, a new PUSI, a duplicate): its time cannot be placed.
        broken_++;
        drop_es(p, first, false);
        release_held_af(p);
        p.unit = Pid::Unit::drop;
        if (dup || !v.pusi) {
            if (dup) span_.hold(v);       // lets the span clear its duplicate mark
            drop_es(p, v.p, dup);
            return;
        }
    } else if (dup && p.seen_payload) {
        // The decoder keeps the first copy: the second goes the same way, rewritten alike.
        // A copy is optional (it never advances CC), so one that cannot be rewritten alike,
        // the continuation of a split header, is removed.
        if (!p.prev_kept || p.prev_cont) {
            drop_es(p, v.p, true);
            return;
        }
        if (v.pusi && p.unit == Pid::Unit::keep) {
            PesHeader h;
            if (!parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) ||
                !rewrite_pes_timestamps(v, h, p.pts33, p.dts33)) {
                drop_es(p, v.p, true);
                return;
            }
        }
        keep_es(p, v.p);
        return;
    }
    if (!payload) {                       // adaptation only: renumbered with its PID
        // Behind a held header it waits for it (the span lets it pass), so the PID's
        // PCRs leave in order.
        if (span_.held(v.pid)) p.held_af.insert(p.held_af.end(), v.p, v.p + PKT);
        else keep_es(p, v.p);
        return;
    }
    if (!v.pusi) {
        if (p.unit == Pid::Unit::keep || p.unit == Pid::Unit::pass) keep_es(p, v.p);
        else drop_es(p, v.p, false);      // a dropped PES, or joined mid-PES
        return;
    }
    if (span_.hold(v)) {                  // the header continues in the next packet
        p.held_h = arrival_;
        p.held_di = di;
        return;
    }
    PesHeader h;
    if (!parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h)) {
        p.unit = Pid::Unit::pass;         // sections on an ES PID: no PES time to rewrite
        keep_es(p, v.p);
        return;
    }
    int64_t pts33 = h.pts, dts33 = h.dts;
    if (!h.complete) {                    // a duplicate's twin the span let pass
        broken_++;
        p.unit = Pid::Unit::drop;
    } else if (start_pes(p, h, arrival_, di, pts33, dts33) &&
               rewrite_pes_timestamps(v, h, pts33, dts33)) {
        keep_es(p, v.p);
        return;
    }
    p.unit = Pid::Unit::drop;
    drop_es(p, v.p, false);
}

bool RestampCore::in_epoch(const Program& g, int64_t pts90k) const {
    const int64_t sigma = pts90k_to_ns(pts90k);
    for (const VirtualStc::EpochInfo& e : g.stc.epochs())
        if (sigma >= e.lo_ns && sigma <= e.hi_ns) return true;
    return false;
}

int64_t RestampCore::unwrap_pes(Pid& p, int64_t pts33) {
    // The PES must sit in the PCR's 2^33 period. Both unwraps are continuous, so a
    // source jump near half the wrap folds them apart: the period an epoch's range
    // holds wins (a straddler stays on its old one), else the one nearest the STC.
    Program& g = *p.prog;
    const int64_t stc = g.stc.source_stc_90k();
    const int64_t pu = p.unwrap.feed(pts33, stc);
    if (g.degraded || in_epoch(g, pu)) return pu;   // degraded: epochs on the PES's own timeline
    const int64_t near = unwrap_near(pts33, stc);
    int64_t pick = near;
    for (const int64_t c : {near, pu - PTS_WRAP, pu + PTS_WRAP})
        if (in_epoch(g, c)) {
            pick = c;
            break;
        }
    if (pick == pu) return pu;
    p.unwrap.reset();
    return p.unwrap.feed(pts33, pick);
}

bool RestampCore::start_pes(Pid& p, const PesHeader& h, int64_t arrival, bool di, int64_t& pts33,
                            int64_t& dts33) {
    Program& g = *p.prog;
    if (h.pts < 0) {                      // no time of its own: the fate of the PES before it
        pes_no_pts_++;
        p.unit = p.unit == Pid::Unit::keep ? Pid::Unit::keep : Pid::Unit::drop;
        return p.unit == Pid::Unit::keep;
    }
    // Live edits of O or a trim apply per PID from its next PUSI with a time (part
    // 4.4): one without has nothing to shift, and must not swallow the edit's gap.
    const int64_t target = target_shift(p.pid);
    const bool edited = p.have_last && target != p.shift;
    if (target != p.shift) {
        p.shift = target;
        update_pcr_shift(g);
    }
    const int64_t d90 = h.dts >= 0 ? fold33(h.dts - h.pts) : 0;
    record(TraceKind::pes, p.pid, (uint64_t)h.pts, (int32_t)clamp64(d90, INT32_MIN, INT32_MAX),
           trace_flags(di, p.cls), arrival);
    const int64_t arrival_h = arrival + base_;
    // house: the PTS on house time; key_house: what the guard compares (video: DTS).
    int64_t house, key_house, out_pts, d = 0, own = 0;
    uint32_t epoch = 0;
    // The PES's own spacing from the PID's previous one, on source time (an edit or an
    // epoch moves only the mapping): its length while the PID has no interval yet.
    auto spacing = [&](int64_t src) {
        own = p.have_src && src > p.last_src && src - p.last_src <= OUTAGE_NS ? src - p.last_src : 0;
        p.have_src = true;
        p.last_src = src;
    };
    if (cfg_.mode == RestampConfig::Mode::fixed) {
        // house = PES - 1 h as received (+ the base time), moved by a constant in
        // ticks so the bytes keep the mux's exact spacing (part 4.2).
        house = house_from_mux_pts(h.pts, arrival) + base_;
        const bool sane = d90 >= -Unwrapper::DTS_MAX_GAP_90K && d90 <= Unwrapper::DTS_MAX_GAP_90K;
        if (h.dts >= 0 && !sane) dts_bad_fixed_++;
        d = h.dts >= 0 && sane ? d90 : 0;
        out_pts = floor_mod(h.pts + ns_to_pts90k(base_ + p.shift), PTS_WRAP);
        key_house = house + (p.cls == StreamClass::video ? pts90k_to_ns(d) : 0);
        spacing(key_house);
    } else {
        const int64_t pu = unwrap_pes(p, h.pts);
        const int64_t du = p.unwrap.feed_dts(h.dts, pu);
        d = du != Unwrapper::NO_DTS ? du - pu : 0;
        // Video is mapped by its DTS: decode order, the order its guard compares, so an
        // epoch switch never takes a P frame onto the new mapping ahead of its B frames.
        const bool by_dts = p.cls == StreamClass::video && du != Unwrapper::NO_DTS;
        const int64_t s90 = by_dts ? du : pu;
        spacing(pts90k_to_ns(s90));
        if (p.pid == g.ref_pid) {         // the warm reference lock of degraded mode
            g.stc.feed_ref_pes(p.pid, s90, arrival);
            pull_events(g);
        }
        const VirtualStc::Mapping m = g.stc.map(p.pid, s90, arrival);
        pull_events(g);
        if (m.stale) {
            // A backlog's (B-39): on its seed it would leave far ahead of arrival, and once the
            // line moves onto the floor it would overlap the live content. Counted as overlap.
            const int64_t len = p.interval > 0 ? p.interval : own;
            p.unit = Pid::Unit::drop;
            p.clean = false;
            p.backlog = true;
            p.run_pes++;
            p.run_ns += len;
            p.dropped_pes++;
            g.dropped_pes++;
            g.dropped_ns += len;
            return false;
        }
        if (!m.valid) {                   // no clock yet: nowhere on house time to put it
            unmapped_++;
            p.unit = Pid::Unit::drop;
            p.clean = false;
            return false;
        }
        epoch = m.epoch;
        key_house = m.house_ns;
        house = by_dts ? m.house_ns - pts90k_to_ns(d) : m.house_ns;
        out_pts = floor_mod(mux_pts_from_house(m.house_ns + p.shift) - (by_dts ? d : 0), PTS_WRAP);
    }
    // PTS and DTS keep their exact distance: one mapping per PES, and the reorder
    // delay is content. A damaged DTS decodes at its PTS.
    const int64_t out_dts = floor_mod(out_pts + d, PTS_WRAP);
    p.leads.emplace_back(arrival_h, house - arrival_h);
    while (p.leads.front().first < arrival_h - LEAD_WINDOW_NS) p.leads.pop_front();

    const int64_t key = key_house + p.shift;
    if (p.have_last && key <= p.last_key) {
        // Overlap (R18): what the bus already carries is not written again, so no
        // PID's time steps back. Video compares DTS, the rest PTS.
        const int64_t len = p.interval > 0 ? p.interval : own;
        p.prev_epoch = epoch;
        p.unit = Pid::Unit::drop;
        p.clean = false;
        p.run_pes++;
        p.run_ns += len;
        p.dropped_pes++;
        g.dropped_pes++;
        g.dropped_ns += len;
        return false;
    }
    const char* why = nullptr;
    bool jump = false;
    if (p.have_last) {
        // A gap is checked on a PID's first PES under a newer epoch; a straddler back on
        // an older one is no new epoch.
        if (epoch > p.max_epoch) why = "epoch";
        else if (edited) why = "edit";
        else if (p.outage) why = "outage";
        else if (p.backlog) why = "backlog";
        // Onto another epoch than its last PES's, kept or dropped (a straddler back from a dropped
        // run, a clamped PID back on the program's): the hole it shows, a PES or more (B-48).
        else if (epoch != p.prev_epoch && key > p.last_key + 2 * p.interval) why = "epoch";
        else if (cfg_.mode == RestampConfig::Mode::fixed && p.n_spacing >= 2 &&
                 key - p.last_key > 2 * upper_median(p.spacing, p.n_spacing) &&
                 (p.cls != StreamClass::video || key - (p.last_key + p.interval) >= GAP_FLAG_NS)) {
            // More than two PES lengths, the length being the upper median of the last three
            // spacings: a short PES (an ASRC's first output, a relock's remainder) never sets it.
            // Video also needs a hole of GAP_FLAG_NS: a dropped frame is no gap (B-89).
            why = "jump";
            jump = true;
        }
    }
    const bool gap = why && key > p.last_key + p.interval;
    if (gap) push_gap(p, p.last_key + p.interval, key, why, epoch, arrival_h);
    // The outage check runs until a PES shows its gap, or one comes in a later buffer.
    if (gap || arrival_h > outage_h_) p.outage = false;
    if (p.run_pes) {
        Event e = make_event(Event::Kind::overlap, g.number, p.pid, p.backlog ? "backlog" : "", arrival_h, epoch);
        e.dropped_ns = p.run_ns;
        events_.push_back(e);
        p.run_pes = 0;
        p.run_ns = 0;
    }
    p.backlog = false;
    // The spacing of two PES in a row with nothing between, on one mapping: the PID's
    // PES length (a straddler's return to a newer epoch is a jump, not a length).
    const bool spaced = p.have_last && p.clean && epoch == p.last_epoch;
    if (spaced && !why) p.interval = key - p.last_key;
    // A jump's spacing joins the reference, or a lasting cadence rise would read as a jump forever.
    if (spaced && (!why || jump)) {
        p.spacing[p.spacing_at] = key - p.last_key;
        p.spacing_at = (uint8_t)((p.spacing_at + 1) % 3);
        if (p.n_spacing < 3) p.n_spacing++;
    }
    p.have_last = p.clean = true;
    p.last_key = key;
    p.last_h = arrival_h;
    p.max_epoch = std::max(p.max_epoch, epoch);
    p.last_epoch = p.prev_epoch = epoch;
    p.unit = Pid::Unit::keep;
    pts33 = p.pts33 = out_pts;
    dts33 = p.dts33 = out_dts;
    return true;
}

// Timed by the PES that shows it, as its overlap is: a header held across buffers replays alike.
void RestampCore::push_gap(Pid& p, int64_t start, int64_t end, const char* why, uint32_t epoch, int64_t at_h) {
    Program& g = *p.prog;
    res_->gaps.push_back(Gap{g.number, p.pid, start, end, why, out_bytes_, p.out_cc});
    Event e = make_event(Event::Kind::gap, g.number, p.pid, why, at_h, epoch);
    e.gap_ns = end - start;
    events_.push_back(e);
    g.gaps++;
    g.gap_ns += end - start;
    // An outage's gap: process() flagged the first PCR after the outage already.
    if (end - start >= GAP_FLAG_NS && !p.outage) g.flag_pcr = true;
}

void RestampCore::tick(int64_t now_ns) {
    for (auto& g : progs_) g->stc.tick(now_ns);
}

std::vector<RestampCore::Gap> RestampCore::outage_gaps(int64_t now_ns) const {
    // From the end of what each PID emitted, as the gap on resume will start (start_pes);
    // a PID whose content still runs past now (its lead) has no gap yet.
    std::vector<Gap> out;
    const int64_t now_h = now_ns + base_;
    for (const auto& g : progs_)
        for (int pid : g->es) {
            const Pid* p = pids_[pid].get();
            if (!p || p->prog != g.get() || !p->have_last) continue;
            const int64_t start = p->last_key + p->interval;
            if (now_h > start) out.push_back(Gap{g->number, pid, start, now_h, "outage", 0, p->out_cc});
        }
    return out;
}

void RestampCore::flush() {
    walker_.reset();
    for (auto& p : pids_) {
        if (!p) continue;
        // A held header goes with the flush, and the rest of its PES after it; both are
        // removed steps, so the PID's CC stays continuous.
        if (span_.held(p->pid)) {
            p->unit = Pid::Unit::drop;
            if (p->emitted) p->cc_delta = (uint8_t)((p->cc_delta + 1) & 0x0F);
            removed_++;
        }
        p->held_af.clear();
    }
    span_.reset();
}

RestampCore::Stats RestampCore::stats() {
    Stats s;
    s.mode = cfg_.mode;
    for (auto& gp : progs_) {
        Program& g = *gp;
        ProgramStats ps;
        ps.program = g.number;
        if (cfg_.mode == RestampConfig::Mode::stc) ps.clock = g.stc.stats();
        ps.gaps = g.gaps;
        ps.gap_ns_total = g.gap_ns;
        ps.dropped_pes = g.dropped_pes;
        ps.dropped_ns_total = g.dropped_ns;
        s.programs.push_back(ps);
        // Every program's discovery reads the PAT: the largest count, not the sum.
        s.psi_unsupported_sections = std::max(s.psi_unsupported_sections, g.psi.unsupported_sections());
        for (int pid : g.es) {
            const Pid* p = pids_[pid].get();
            if (!p) continue;
            PidStats q;
            q.program = g.number;
            q.pid = pid;
            q.stream_type = p->stream_type;
            q.cls = p->cls;
            std::vector<int64_t> v;
            for (const auto& e : p->leads)
                if (e.first >= arrival_h_ - LEAD_WINDOW_NS) v.push_back(e.second);
            if (!v.empty()) {
                std::sort(v.begin(), v.end());
                q.lead_min_ns = v.front();
                q.lead_median_ns = v[(v.size() - 1) / 2];
                q.lead_max_ns = v.back();
                q.lead_count = (uint32_t)v.size();
            }
            const auto it = trims_.find(pid);
            q.trim_ns = it == trims_.end() ? 0 : it->second;
            q.shift_ns = p->shift;
            q.dropped_pes = p->dropped_pes;
            s.pids.push_back(q);
        }
    }
    s.desync_bytes = walker_.desync_bytes();
    s.cc_lost = cc_in_.lost();
    s.header_spans = span_.spans();
    s.pes_no_pts = pes_no_pts_;
    s.dts_discarded = dts_bad_fixed_;
    for (const auto& p : pids_)
        if (p) s.dts_discarded += p->unwrap.dts_discarded();
    s.unmapped_pes = unmapped_;
    s.broken_spans = broken_;
    s.unknown_pid_packets = unknown_;
    s.removed_packets = removed_;
    s.pcr_kept_packets = pcr_kept_;
    return s;
}

std::vector<RestampCore::Event> RestampCore::take_events() {
    std::vector<Event> out;
    out.swap(events_);
    return out;
}

}  // namespace mrts
