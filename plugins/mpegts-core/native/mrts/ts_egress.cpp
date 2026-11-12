#include "ts_egress.h"

#include <algorithm>
#include <cstring>

#include "demux_core.h"
#include "ts_gap.h"
#include "ts_house.h"

namespace mrts {
namespace {

int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && a < 0) ? q - 1 : q;
}

int64_t ceil_step(int64_t v, int64_t step) { return -floor_div(-v, step) * step; }

// ts_house's timing_pes on a parsed header: a video or audio stream_id, or the PCR carrier.
bool timing_sid(uint8_t sid, int pid, int timing_pid) {
    return (sid & 0xF0) == 0xE0 || (sid & 0xE0) == 0xC0 || pid == timing_pid;
}

class NowReader : public ClockReader {
  public:
    explicit NowReader(int64_t now) : now_(now) {}
    int64_t read(size_t) const override { return now_; }

  private:
    int64_t now_;
};

}  // namespace

// --- EgressDelay (part 4.4) -----------------------------------------------------------------

EgressDelay::EgressDelay(const EgressConfig& cfg) : cfg_(cfg), d_e_(cfg.floor_ns + cfg.margin_ns) {}

int64_t EgressDelay::eps_ns(const std::optional<int64_t>& error_us) {
    return error_us ? std::min(*error_us * 1000, EPS_CAP_NS) : EPS_CAP_NS;
}

int64_t EgressDelay::need(int64_t lam, int64_t eps) const {
    return ceil_step(lam + cfg_.margin_ns + eps, STEP_NS);
}

void EgressDelay::on_gap(int64_t end_ns, int64_t g_ns) {
    if (g_ns <= 0) return;
    // Only what no earlier gap covered counts: one hole's markers on several PIDs count once.
    const int64_t start = have_gap_until_ ? std::max(end_ns - g_ns, gap_until_) : end_ns - g_ns;
    gap_ns_ += std::max<int64_t>(0, end_ns - start);
    gap_until_ = have_gap_until_ ? std::max(gap_until_, end_ns) : end_ns;
    have_gap_until_ = true;
}

int EgressDelay::count(Change* out, int n) {
    for (int k = 0; k < n; k++)
        if (out[k].from_ns != out[k].to_ns) changes_++;
    return n;
}

int EgressDelay::on_pes(int64_t lateness_ns, int64_t eps, Change out[2]) {
    if (lateness_ns > LATE_MAX_NS) {
        off_house_++;
        return 0;
    }
    const int64_t lam = std::max<int64_t>(0, lateness_ns);
    const int64_t nd = need(lam, eps);
    const int64_t old = d_e_;
    if (!started_) {
        started_ = true;
        gap_ns_ = 0;
        int64_t v = std::max(cfg_.floor_ns, nd);
        int n = 1;
        if (cfg_.max_ns > 0 && v > cfg_.max_ns) {
            v = cfg_.max_ns;
            max_episode_ = true;
            out[1] = {Kind::max, v, v, lam, 0};
            n = 2;
        }
        d_e_ = v;
        out[0] = {Kind::start, old, v, lam, 0};
        return count(out, n);
    }
    if (gap_ns_ > 0) {
        const int64_t g = gap_ns_;
        gap_ns_ = 0;
        const int64_t target = std::max(cfg_.floor_ns, nd);
        if (target < d_e_) {
            d_e_ = std::max(target, ceil_step(d_e_ - g, STEP_NS));
            max_episode_ = false;
            out[0] = {Kind::lower, old, d_e_, lam, g};
            return count(out, 1);
        }
    }
    if (lam > d_e_ - cfg_.headroom_ns) {
        int64_t v = nd;
        if (cfg_.max_ns > 0 && v > cfg_.max_ns) {
            v = cfg_.max_ns;
            const bool first = !max_episode_;
            max_episode_ = true;
            if (v <= old) {
                if (!first) return 0;
                out[0] = {Kind::max, old, old, lam, 0};
                return 1;
            }
            d_e_ = v;
            out[0] = {Kind::raise, old, v, lam, 0};
            int n = 1;
            if (first) out[n++] = {Kind::max, v, v, lam, 0};
            return count(out, n);
        }
        d_e_ = v;
        out[0] = {Kind::raise, old, v, lam, 0};
        return count(out, 1);
    }
    return 0;
}

const char* egress_event_name(EgressEvent::Kind k) {
    switch (k) {
        case EgressEvent::Kind::d_e_start: return "d-e-start";
        case EgressEvent::Kind::d_e_raise: return "d-e-raise";
        case EgressEvent::Kind::d_e_lower: return "d-e-lower";
        case EgressEvent::Kind::d_e_max: return "d-e-max";
        case EgressEvent::Kind::re_epoch: return "re-epoch";
        case EgressEvent::Kind::pcr_pid_assigned: return "pcr-pid-assigned";
        case EgressEvent::Kind::pmt_grew: return "pmt-grew";
        case EgressEvent::Kind::cc_lost_in: return "cc-lost-in";
    }
    return "?";
}

// --- EgressResult ---------------------------------------------------------------------------

void EgressResult::clear() {
    pkts_.clear();
    edits_.clear();
    pool_.clear();
}

void EgressResult::push(uint32_t index, EgressEdit::Op op, const uint8_t* b) {
    const uint32_t at = (uint32_t)pool_.size();
    if (b) pool_.insert(pool_.end(), b, b + PKT);
    edits_.push_back({index, op, at});
}

void EgressResult::apply(std::vector<uint8_t>& out) const {
    size_t next = 0;                          // the first packet not yet passed or edited
    for (const EgressEdit& e : edits_) {
        for (; next < e.index && next < pkts_.size(); next++) out.insert(out.end(), pkts_[next], pkts_[next] + PKT);
        if (e.op == EgressEdit::Op::insert) {
            out.insert(out.end(), bytes(e), bytes(e) + PKT);
            continue;
        }
        if (e.op == EgressEdit::Op::replace) out.insert(out.end(), bytes(e), bytes(e) + PKT);
        next = e.index + 1;
    }
    for (; next < pkts_.size(); next++) out.insert(out.end(), pkts_[next], pkts_[next] + PKT);
}

// --- one program ----------------------------------------------------------------------------

struct EgressCore::Prog {
    Prog(int n, int pid, const EgressConfig& cfg)
        : number(n), pmt_pid(pid), sched(cfg.pcr_interval_ns), delay(cfg) {
        psi.select_program(n);
    }
    int number, pmt_pid;
    PsiDiscovery psi;
    std::optional<Pmt> pmt_in;
    int pcr_out = -1;                         // -1: none
    int assigned = -1;
    PcrScheduler sched;
    EgressDelay delay;
    int version_out = 0;
    bool has_section = false, has_key = false;
    std::vector<uint8_t> section, key;
    uint8_t pmt_cc = 0;
    bool grew_told = false;
    std::optional<int64_t> pcr_last_t;
    EgressStats st;
};

// --- PMT sections in, packet by packet ------------------------------------------------------

void EgressCore::SectionAssembler::feed(const PacketView& v, std::vector<uint8_t>& store,
                                        std::vector<Done>& out) {
    if (v.payload_off >= PKT) return;
    const uint8_t* body = v.p + v.payload_off;
    const size_t n = PKT - v.payload_off;
    if (collecting) packets++;
    if (v.pusi) {
        const size_t ptr = body[0];
        if (collecting) {
            const size_t a = std::min<size_t>(1, n), b = std::min(1 + ptr, n);
            buf.insert(buf.end(), body + a, body + b);
            take(store, out);
        }
        const size_t from = std::min(1 + ptr, n);
        buf.assign(body + from, body + n);
        collecting = true;
        packets = 1;
    } else if (collecting) {
        buf.insert(buf.end(), body, body + n);
    }
    take(store, out);
}

void EgressCore::SectionAssembler::take(std::vector<uint8_t>& store, std::vector<Done>& out) {
    while (collecting) {
        if (!buf.empty() && buf[0] == 0xFF) {
            collecting = false;               // stuffing after the last section
            break;
        }
        if (buf.size() < 3) break;
        const size_t want = 3 + (((size_t)(buf[1] & 0x0F) << 8) | buf[2]);
        if (buf.size() < want) break;
        out.push_back({store.size(), want, packets});
        store.insert(store.end(), buf.begin(), buf.begin() + want);
        buf.erase(buf.begin(), buf.begin() + want);
        if (buf.empty()) collecting = false;
    }
}

// --- EgressCore -----------------------------------------------------------------------------

EgressCore::EgressCore(const EgressConfig& cfg) : cfg_(cfg) {
    one_.resize(1);
    res_.pkts_.reserve(64);
    res_.edits_.reserve(64);
    res_.pool_.reserve(64 * PKT);
}

EgressCore::~EgressCore() = default;

std::vector<EgressEvent> EgressCore::take_events() {
    std::vector<EgressEvent> e;
    e.swap(events_);
    return e;
}

EgressCore::Prog* EgressCore::prog_of(int number) const {
    for (const auto& p : progs_)
        if (p->number == number) return p.get();
    return nullptr;
}

bool EgressCore::stats(int program, EgressStats* out) const {
    const Prog* p = prog_of(program);
    if (!p) return false;
    *out = p->st;
    out->program = program;
    out->d_e_ns = p->delay.d_e();
    out->d_e_changes = p->delay.changes();
    out->lateness_off_house = p->delay.off_house();
    out->pmt_version = p->version_out;
    out->pcr_pid = p->pcr_out;
    return true;
}

std::vector<int> EgressCore::programs() const {
    std::vector<int> r;
    for (const auto& p : progs_) r.push_back(p->number);
    return r;
}

const EgressResult& EgressCore::process(const uint8_t* data, size_t len, int64_t now_ns, const ClockReader& clk) {
    return run(data, len, now_ns, clk, false, 0);
}

const EgressResult& EgressCore::process(const uint8_t* data, size_t len, int64_t now_ns) {
    return run(data, len, now_ns, NowReader(now_ns), false, 0);
}

const EgressResult& EgressCore::on_gap(const uint8_t* data, size_t len, int64_t now_ns, int64_t end_ns,
                                       const ClockReader& clk) {
    return run(data, len, now_ns, clk, true, end_ns);
}

const EgressResult& EgressCore::on_gap(const uint8_t* data, size_t len, int64_t now_ns, int64_t end_ns) {
    return run(data, len, now_ns, NowReader(now_ns), true, end_ns);
}

const EgressResult& EgressCore::run(const uint8_t* data, size_t len, int64_t now_ns, const ClockReader& clk,
                                    bool is_gap, int64_t gap_end) {
    t_ = now_ns;
    clk_ = &clk;
    res_.clear();
    walker_.feed(data, len, [&](const PacketView& v) {
        if (v.p >= data && v.p < data + len) {
            res_.pkts_.push_back(v.p);
        } else {                              // joined across buffers: kept in the result
            std::memcpy(res_.join_, v.p, PKT);
            res_.pkts_.push_back(res_.join_);
        }
    });
    apply_clock(now_ns);
    started_ = true;
    const size_t n = res_.pkts_.size();
    if (is_gap) {
        head();
        for (size_t i = 0; i < n; i++) {
            const int64_t g = read_gap_length(res_.pkts_[i]);
            if (g >= 0) {
                counters_.gap_markers++;
                gap(ts_pid(res_.pkts_[i]), gap_end, g);
            }
            res_.push((uint32_t)i, EgressEdit::Op::drop, nullptr);
        }
        have_last_now_ = true;
        last_now_ = now_ns;
        base_ += n;
        clk_ = nullptr;
        return res_;
    }
    if (have_last_now_ && now_ns - last_now_ >= cfg_.gap_lower_min_ns) gap(-1, now_ns, now_ns - last_now_);
    have_last_now_ = true;
    last_now_ = now_ns;
    head();
    uint8_t work[PKT];
    PacketView v;
    for (size_t i = 0; i < n; i++) {
        const uint8_t* orig = res_.pkts_[i];
        std::memcpy(work, orig, PKT);
        parse_packet(work, &v);
        if (cc_in_.feed(v) == CcTracker::Result::Lost) {
            counters_.cc_lost_in++;
            EgressEvent e{EgressEvent::Kind::cc_lost_in};
            e.pid = v.pid;
            event(i, e);
        }
        pcr_due(i, v);
        const Verdict verdict = on_packet(i, v);
        if (verdict == Verdict::drop)
            res_.push((uint32_t)i, EgressEdit::Op::drop, nullptr);
        else if (verdict == Verdict::pass && std::memcmp(work, orig, PKT) != 0)
            res_.push((uint32_t)i, EgressEdit::Op::replace, work);
    }
    base_ += n;
    clk_ = nullptr;
    return res_;
}

void EgressCore::flush(std::vector<uint8_t>& out) {
    std::vector<uint8_t> held;
    span_.flush(held);
    for (size_t at = 0; at + PKT <= held.size(); at += PKT) {
        out.insert(out.end(), held.begin() + at, held.begin() + at + PKT);
        auto it = held_af_.find(ts_pid(held.data() + at));
        if (it == held_af_.end()) continue;
        for (const auto& b : it->second) out.insert(out.end(), b.begin(), b.end());
        held_af_.erase(it);
    }
}

// --- the clock ------------------------------------------------------------------------------

void EgressCore::apply_clock(int64_t now) {
    if (pending_) {
        const ClockDecl c = *pending_;
        pending_.reset();
        const ClockDecl old = clock_;
        const int64_t old_e = e_ns_;
        clock_ = c;
        e_ns_ = c.known ? c.e_ns : 0;
        const uint8_t cls = c.error_us ? hcdesc::error_class((double)*c.error_us) : hcdesc::ERROR_CLASS_UNKNOWN;
        if (!started_) {
            pub_class_ = cls;
            have_cand_ = false;
        } else {
            if (e_ns_ != old_e || c.seq != old.seq) {
                reepoch_ = true;
                counters_.re_epochs++;
                EgressEvent e{EgressEvent::Kind::re_epoch};
                e.seq = c.seq;
                e.from_seq = old.seq;
                e.delta_ns = e_ns_ - old_e;
                event(0, e);
            }
            if (cls == pub_class_) {
                have_cand_ = false;
            } else if (!have_cand_ || cls != cand_class_) {
                have_cand_ = true;
                cand_class_ = cls;
                cand_since_ = now;
            }
        }
        dirty_ = true;
    }
    if (have_cand_ && now - cand_since_ >= ERROR_HOLD_NS) {
        pub_class_ = cand_class_;
        have_cand_ = false;
        dirty_ = true;
    }
}

HouseTimeDecl EgressCore::decl(const Prog& p) const {
    const ClockDecl& c = clock_;
    const bool ptp = c.ptp_domain >= 0 && c.gm.has_value();
    HouseTimeDecl d;
    d.house_time_tai = c.known;
    d.disciplined = c.disciplined;
    d.traceable = c.known && c.traceable;
    d.ptp_valid = ptp;
    d.sync_source = c.source;
    d.tai_utc_offset_s = (uint8_t)std::min<int64_t>(std::max<int64_t>(c.tai_offset_s, 0), 255);
    d.ptp_domain = ptp ? (uint8_t)c.ptp_domain : 0xFF;
    d.clock_error_class = pub_class_;
    d.gm_identity = ptp ? *c.gm : ~0ull;
    d.epoch_seq = (uint16_t)(c.seq & 0xFFFF);
    d.d_e_90k = (uint32_t)ns_to_pts90k(p.delay.d_e());
    d.timeline_id = c.timeline_id;
    return d;
}

void EgressCore::head() {
    const bool reepoch = reepoch_, dirty = dirty_;
    reepoch_ = dirty_ = false;
    for (auto& up : progs_) {
        Prog& p = *up;
        if (!p.has_section) continue;
        if (reepoch) {
            rebuild(p);
            discontinuity(0, p, true);
        } else if (dirty && rebuild(p)) {
            emit_pmt(0, p);
        }
    }
}

// --- packets --------------------------------------------------------------------------------

void EgressCore::event(size_t i, EgressEvent e) {
    e.packet = base_ + i;
    events_.push_back(e);
}

int64_t EgressCore::read(size_t i) {
    t_ = clk_->read(i);
    return t_;
}

bool EgressCore::all_known() const {
    if (!pat_known_) return false;
    for (const auto& p : progs_)
        if (!p->pmt_in) return false;
    return true;
}

EgressCore::Verdict EgressCore::on_packet(size_t i, PacketView& v) {
    const int pid = v.pid;
    if (pid == PID_PAT) {
        on_pat(v);
        return Verdict::pass;
    }
    for (const auto& p : progs_)
        if (p->pmt_pid == pid) return on_pmt(i, v);
    Prog* p = pid_prog_[pid];
    if (!p) {
        if (pid < 0x20 || pid == PID_NULL || all_known()) return Verdict::pass;
        counters_.dropped_before_pmt++;
        return Verdict::drop;
    }
    return on_es(i, v, *p);
}

void EgressCore::on_pat(const PacketView& v) {
    SectionSig sig;
    if (section_signature(v.p, &sig) && sig.table_id == TABLE_PAT && !(sig == pat_sig_)) {
        pat_pkts_.clear();
        pat_new_sig_ = sig;
        pat_resync_ = true;
    }
    TsPacket pk;
    std::memcpy(pk.b, v.p, PKT);
    pat_pkts_.push_back(pk);
    if (pat_pkts_.size() > 128) pat_pkts_.pop_front();
    one_[0] = pk;
    for (auto& p : progs_) p->psi.feed(one_);
    if (!pat_resync_) return;
    const std::vector<std::pair<int, int>> pat = parse_pat(pat_pkts_);
    if (pat.empty()) return;
    pat_sig_ = pat_new_sig_;
    pat_resync_ = false;
    pat_known_ = true;
    std::vector<std::unique_ptr<Prog>> progs;
    std::vector<bool> from_old;
    for (const auto& [number, pmt_pid] : pat) {
        size_t k = 0;
        while (k < progs.size() && progs[k]->number != number) k++;
        if (k < progs.size() && from_old[k]) {   // listed twice: python's dict keeps the slot
            progs[k]->pmt_pid = pmt_pid;
            continue;
        }
        std::unique_ptr<Prog> prog;
        bool old = false;
        for (auto& o : progs_) {
            if (o && o->number == number) {
                prog = std::move(o);
                old = true;
                break;
            }
        }
        if (!prog) {
            prog = std::make_unique<Prog>(number, pmt_pid, cfg_);
            prog->psi.feed(std::vector<TsPacket>(pat_pkts_.begin(), pat_pkts_.end()));
        }
        prog->pmt_pid = pmt_pid;
        if (k < progs.size()) {
            progs[k] = std::move(prog);
            from_old[k] = old;
        } else {
            progs.push_back(std::move(prog));
            from_old.push_back(old);
        }
    }
    progs_ = std::move(progs);
    map_pids();
}

void EgressCore::map_pids() {
    std::fill(std::begin(pid_prog_), std::end(pid_prog_), nullptr);
    for (const auto& up : progs_) {
        Prog* p = up.get();
        if (!p->pmt_in) continue;
        for (const PmtStream& s : p->pmt_in->streams)
            if (s.pid >= 0 && s.pid < 8192 && !pid_prog_[s.pid]) pid_prog_[s.pid] = p;
        const int pcr = p->pmt_in->pcr_pid;
        if (pcr != PID_NULL && pcr >= 0 && pcr < 8192 && !pid_prog_[pcr]) pid_prog_[pcr] = p;
    }
}

EgressCore::Verdict EgressCore::on_pmt(size_t i, PacketView& v) {
    std::memcpy(one_[0].b, v.p, PKT);
    for (auto& p : progs_)
        if (p->pmt_pid == v.pid) p->psi.feed(one_);
    sec_store_.clear();
    secs_.clear();
    asm_[v.pid].feed(v, sec_store_, secs_);
    pkt_out_.clear();
    for (const SectionAssembler::Done& d : secs_) {
        const uint8_t* sec = sec_store_.data() + d.off;
        if (d.len < 12 || sec[0] != TABLE_PMT) continue;
        Prog* p = prog_of((sec[3] << 8) | sec[4]);
        if (!p || p->pmt_pid != v.pid || !p->psi.pmt()) continue;
        if (!p->pmt_in || !(*p->psi.pmt() == *p->pmt_in)) new_pmt(i, *p, *p->psi.pmt());
        const size_t before = pkt_out_.size();
        packetise_section(p->pmt_pid, p->section, p->pmt_cc, pkt_out_);
        p->st.pmt_sent++;
        const int made = (int)((pkt_out_.size() - before) / PKT);
        if (made > d.packets && !p->grew_told) {
            p->grew_told = true;
            EgressEvent e{EgressEvent::Kind::pmt_grew};
            e.program = p->number;
            e.in_packets = d.packets;
            e.out_packets = made;
            event(i, e);
        }
    }
    if (pkt_out_.empty()) return Verdict::drop;
    const size_t count = pkt_out_.size() / PKT;
    for (size_t k = 0; k + 1 < count; k++) res_.push((uint32_t)i, EgressEdit::Op::insert, pkt_out_.data() + k * PKT);
    res_.push((uint32_t)i, EgressEdit::Op::replace, pkt_out_.data() + (count - 1) * PKT);
    return Verdict::replace;
}

int EgressCore::choose_pcr(const std::vector<PmtStream>& streams) const {
    for (EsClass want : {EsClass::Video, EsClass::Audio}) {
        for (const PmtStream& s : streams) {
            const std::optional<EsPlan> plan = classify(s.stream_type, s.es_info);
            const EsClass c = plan ? plan->cls : unknown_class(s.stream_type, s.es_info);
            if (c == want) return s.pid;
        }
    }
    return streams.empty() ? PID_NULL : streams[0].pid;
}

void EgressCore::new_pmt(size_t i, Prog& p, const Pmt& pmt) {
    if (!p.pmt_in) p.version_out = pmt.version;
    p.pmt_in = pmt;
    int pcr = pmt.pcr_pid;
    if (pcr == PID_NULL) {
        pcr = choose_pcr(pmt.streams);
        if (pcr != PID_NULL && pcr != p.assigned) {
            p.assigned = pcr;
            EgressEvent e{EgressEvent::Kind::pcr_pid_assigned};
            e.program = p.number;
            e.pid = pcr;
            event(i, e);
        }
    }
    if (pcr == PID_NULL) pcr = -1;
    if (pcr != p.pcr_out) {
        p.pcr_out = pcr;
        p.sched = PcrScheduler(cfg_.pcr_interval_ns);
        p.sched.saw_payload(pcr >= 0 && pcr < 8192 ? last_cc_[pcr] : 0);
        p.pcr_last_t.reset();
    }
    map_pids();
    rebuild(p);
}

bool EgressCore::rebuild(Prog& p) {
    const Pmt& pmt = *p.pmt_in;
    const std::vector<uint8_t> stripped = hcdesc::strip_from(pmt.program_info);
    std::vector<uint8_t> pi = stripped;
    uint8_t desc[hcdesc::BYTES];
    hcdesc::encode(decl(p), desc);
    pi.insert(pi.end(), desc, desc + hcdesc::BYTES);
    const int pcr = p.pcr_out < 0 ? PID_NULL : p.pcr_out;
    auto build = [&](int version) {
        std::vector<uint8_t> s = build_pmt_section(p.number, pcr, pi, pmt.streams, version);
        return s.empty() ? build_pmt_section(p.number, pcr, stripped, pmt.streams, version) : s;
    };
    std::vector<uint8_t> sec = build(p.version_out);
    // The section without its version and CRC: what a change is judged on.
    std::vector<uint8_t> key;
    if (sec.size() >= 10) {
        key.assign(sec.begin(), sec.begin() + 5);
        key.push_back(sec[5] & 0xC1);
        key.insert(key.end(), sec.begin() + 6, sec.end() - 4);
    }
    if (p.has_key && p.key == key) return false;
    if (p.has_key) {
        p.version_out = (p.version_out + 1) % 32;
        sec = build(p.version_out);
    }
    p.key = std::move(key);
    p.has_key = true;
    p.section = std::move(sec);
    p.has_section = true;
    return true;
}

void EgressCore::emit_pmt(size_t i, Prog& p) {
    pkt_out_.clear();
    packetise_section(p.pmt_pid, p.section, p.pmt_cc, pkt_out_);
    p.st.pmt_sent++;
    for (size_t at = 0; at + PKT <= pkt_out_.size(); at += PKT)
        res_.push((uint32_t)i, EgressEdit::Op::insert, pkt_out_.data() + at);
}

void EgressCore::insert_pcr(size_t i, Prog& p, bool disc) {
    const int64_t t = read(i);
    uint8_t b[PKT];
    build_pcr_packet(p.pcr_out, net_pcr27(t + e_ns_, p.delay.d_e()), p.sched.cc(), disc, b);
    res_.push((uint32_t)i, EgressEdit::Op::insert, b);
    p.st.pcr_inserted++;
    saw_pcr(p, t);
}

void EgressCore::saw_pcr(Prog& p, int64_t t) {
    if (p.pcr_last_t) p.st.pcr_interval_max_ns = std::max(p.st.pcr_interval_max_ns, t - *p.pcr_last_t);
    p.pcr_last_t = t;
    p.sched.saw_pcr(t);
}

void EgressCore::discontinuity(size_t i, Prog& p, bool rebuilt) {
    // Part 4.2 step 7: the new PMT, then a flagged PCR-only packet, before packet i.
    if (!rebuilt) rebuild(p);
    emit_pmt(i, p);
    if (p.pcr_out >= 0) insert_pcr(i, p, true);
}

void EgressCore::pcr_due(size_t i, const PacketView& v) {
    for (auto& up : progs_) {
        Prog& p = *up;
        const int pid = p.pcr_out;
        if (pid < 0 || !p.has_section || span_.held(pid)) continue;
        if (v.pid == pid && v.af_pcr) continue;
        if (p.sched.due(t_)) insert_pcr(i, p, false);
    }
}

void EgressCore::gap(int pid, int64_t end, int64_t g) {
    counters_.gaps++;
    Prog* one = pid >= 0 && pid < 8192 ? pid_prog_[pid] : nullptr;
    for (auto& up : progs_) {
        if (one && up.get() != one) continue;
        up->delay.on_gap(end, g);
        up->pcr_last_t.reset();
    }
}

void EgressCore::write_pcr_at(size_t i, uint8_t* buf, Prog& p, int pid) {
    if (read_pcr(buf) < 0) return;
    const int64_t t = read(i);
    write_pcr(buf, net_pcr27(t + e_ns_, p.delay.d_e()));
    p.st.pcr_written++;
    if (pid == p.pcr_out) saw_pcr(p, t);
}

void EgressCore::times(size_t i, Prog& p, int pid, const PesHeader& h, int64_t& pts33, int64_t& dts33) {
    if (h.pts < 0) return;
    if (timing_sid(h.sid, pid, p.pcr_out)) {
        // Against the latest clock reading, so DTS - PCR >= headroom for the PCR in force.
        lateness(i, p, t_ - house_from_mux_pts(dts33 >= 0 ? dts33 : pts33, t_));
    }
    p.st.pes_rewritten++;
    const NetEpoch e{e_ns_};
    pts33 = bus_to_net(pts33, e);
    if (dts33 >= 0) dts33 = bus_to_net(dts33, e);
}

void EgressCore::lateness(size_t i, Prog& p, int64_t lam) {
    if (lam <= EgressDelay::LATE_MAX_NS) {
        p.st.lateness_ns = lam;
        p.st.lateness_max_ns = std::max(p.st.lateness_max_ns, lam);
    }
    EgressDelay::Change ch[2];
    const int n = p.delay.on_pes(lam, EgressDelay::eps_ns(clock_.error_us), ch);
    bool moved = false;
    for (int k = 0; k < n; k++) {
        static const EgressEvent::Kind kinds[] = {EgressEvent::Kind::d_e_start, EgressEvent::Kind::d_e_raise,
                                                  EgressEvent::Kind::d_e_lower, EgressEvent::Kind::d_e_max};
        EgressEvent e{kinds[(int)ch[k].kind]};
        e.program = p.number;
        e.from_ns = ch[k].from_ns;
        e.to_ns = ch[k].to_ns;
        e.lateness_ns = ch[k].lateness_ns;
        e.gap_ns = ch[k].gap_ns;
        event(i, e);
        moved = moved || ch[k].from_ns != ch[k].to_ns;
    }
    if (moved) discontinuity(i, p, false);
}

EgressCore::Verdict EgressCore::on_es(size_t i, PacketView& v, Prog& p) {
    const int pid = v.pid;
    const bool payload = v.payload_off < PKT;
    if (payload) {
        last_cc_[pid] = v.cc;
        if (pid == p.pcr_out) p.sched.saw_payload(v.cc);
    }
    if (payload && span_.held(pid)) {
        bool joined = false;
        uint8_t first[PKT];
        span_.complete(v, first, [&](const PesHeader& h, int64_t& pts33, int64_t& dts33) {
            joined = true;
            times(i, p, pid, h, pts33, dts33);
        });
        write_pcr_at(i, first, p, pid);
        res_.push((uint32_t)i, EgressEdit::Op::insert, first);
        auto it = held_af_.find(pid);
        if (it != held_af_.end()) {
            for (auto& af : it->second) {
                write_pcr_at(i, af.data(), p, pid);
                res_.push((uint32_t)i, EgressEdit::Op::insert, af.data());
            }
            held_af_.erase(it);
        }
        if (joined) {
            write_pcr_at(i, v.p, p, pid);
            return Verdict::pass;
        }
    }
    if (!payload) {
        if (span_.held(pid)) {
            auto& q = held_af_[pid];
            if (q.size() < MAX_HELD_AF) {
                q.emplace_back();
                std::memcpy(q.back().data(), v.p, PKT);
                counters_.held++;
                return Verdict::drop;
            }
        }
        write_pcr_at(i, v.p, p, pid);
        return Verdict::pass;
    }
    if (v.pusi && !v.scrambled) {
        if (span_.hold(v)) {
            counters_.held++;
            return Verdict::drop;
        }
        PesHeader h;
        if (parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) && h.complete && h.pts >= 0) {
            int64_t pts33 = h.pts, dts33 = h.dts;
            times(i, p, pid, h, pts33, dts33);
            rewrite_pes_timestamps(v, h, pts33, dts33);
        }
    }
    write_pcr_at(i, v.p, p, pid);
    return Verdict::pass;
}

}  // namespace mrts
