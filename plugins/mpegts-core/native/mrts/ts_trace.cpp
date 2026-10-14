#include "ts_trace.h"

#include <algorithm>
#include <climits>
#include <cstring>

#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pcr.h"
#include "ts_pes.h"
#include "ts_psi.h"

namespace mrts {
namespace {

const uint8_t kMagic[4] = {'S', 'T', 'C', 'T'};

// Little-endian by hand: a trace recorded on the Pi replays on any host.
void put_le(uint8_t* p, uint64_t v, int n) {
    for (int i = 0; i < n; i++) p[i] = (uint8_t)(v >> (8 * i));
}

uint64_t get_le(const uint8_t* p, int n) {
    uint64_t v = 0;
    for (int i = 0; i < n; i++) v |= (uint64_t)p[i] << (8 * i);
    return v;
}

}  // namespace

void encode_trace_header(uint64_t count, uint8_t out[TRACE_HEADER_BYTES]) {
    std::memcpy(out, kMagic, 4);
    put_le(out + 4, TRACE_VERSION, 4);
    put_le(out + 8, count, 8);
}

void encode_trace_record(const TraceRecord& r, uint8_t out[TRACE_RECORD_BYTES]) {
    put_le(out, (uint64_t)r.arrival_ns, 8);
    put_le(out + 8, r.value, 8);
    put_le(out + 16, r.pid, 2);
    out[18] = (uint8_t)r.kind;
    out[19] = r.flags;
    put_le(out + 20, (uint32_t)r.dts_minus_pts_90k, 4);
}

TraceRecord decode_trace_record(const uint8_t in[TRACE_RECORD_BYTES]) {
    TraceRecord r;
    r.arrival_ns = (int64_t)get_le(in, 8);
    r.value = get_le(in + 8, 8);
    r.pid = (uint16_t)get_le(in + 16, 2);
    r.kind = (TraceKind)in[18];
    r.flags = in[19];
    r.dts_minus_pts_90k = (int32_t)(uint32_t)get_le(in + 20, 4);
    return r;
}

bool TraceWriter::open(const std::string& path) {
    close();
    mem_.clear();
    f_ = std::fopen(path.c_str(), "wb");
    if (!f_) return false;
    count_ = 0;
    uint8_t h[TRACE_HEADER_BYTES];
    encode_trace_header(0, h);
    ok_ = std::fwrite(h, 1, sizeof h, f_) == sizeof h;
    return ok_;
}

void TraceWriter::open_memory() {
    close();
    mem_.clear();
    memory_ = true;
    ok_ = true;
    count_ = 0;
}

void TraceWriter::write(const TraceRecord& r) {
    if (memory_) {
        mem_.push_back(r);
        count_++;
        return;
    }
    if (!f_) return;
    uint8_t b[TRACE_RECORD_BYTES];
    encode_trace_record(r, b);
    if (std::fwrite(b, 1, sizeof b, f_) != sizeof b) ok_ = false;
    count_++;
}

bool TraceWriter::close() {
    memory_ = false;
    if (!f_) return ok_;
    uint8_t h[TRACE_HEADER_BYTES];
    encode_trace_header(count_, h);
    if (std::fflush(f_) != 0 || std::fseek(f_, 0, SEEK_SET) != 0 ||
        std::fwrite(h, 1, sizeof h, f_) != sizeof h)
        ok_ = false;
    if (std::fclose(f_) != 0) ok_ = false;
    f_ = nullptr;
    return ok_;
}

TraceReader::~TraceReader() {
    if (f_) std::fclose(f_);
}

bool TraceReader::open(const std::string& path) {
    if (f_) std::fclose(f_);
    f_ = std::fopen(path.c_str(), "rb");
    read_ = header_count_ = 0;
    status_ = Status::bad_header;
    if (!f_) return false;
    uint8_t h[TRACE_HEADER_BYTES];
    if (std::fread(h, 1, sizeof h, f_) != sizeof h || std::memcmp(h, kMagic, 4) != 0 ||
        get_le(h + 4, 4) != TRACE_VERSION) {
        std::fclose(f_);
        f_ = nullptr;
        return false;
    }
    header_count_ = get_le(h + 8, 8);
    status_ = header_count_ > 0 ? Status::ok : Status::unclosed;
    return true;
}

bool TraceReader::next(TraceRecord* r) {
    if (!f_ || (header_count_ > 0 && read_ == header_count_)) return false;
    uint8_t b[TRACE_RECORD_BYTES];
    const size_t n = std::fread(b, 1, sizeof b, f_);
    if (n == sizeof b) {
        *r = decode_trace_record(b);
        read_++;
        return true;
    }
    if (n > 0 || read_ < header_count_) status_ = Status::truncated;
    // A closed trace with no records is indistinguishable from an unclosed one, and fine.
    else if (header_count_ == 0 && read_ == 0) status_ = Status::ok;
    return false;
}

// --- TracePlayer -------------------------------------------------------------------

namespace {

// A held header's first packet carries the PES bytes up to PES_header_data_length:
// short of its PTS, so PesHeaderSpan holds it for the next payload packet.
constexpr int HELD_HEAD = 9;
// One silence with no OUTAGE record is filled at most this far (half-outage steps):
// a garbage arrival must not grow the buffer list without bound.
constexpr int64_t FILL_MAX = 200000;

uint8_t stream_id(StreamClass c) {
    return c == StreamClass::video ? 0xE0 : c == StreamClass::audio ? 0xC0 : 0xBD;
}

// For a private PES (0x06) the class comes from its registration, so the table names
// one stream_class() knows; every other stream_type carries its class itself.
std::vector<uint8_t> es_info_for(int stream_type, StreamClass c) {
    if (stream_type != STREAM_TYPE_PRIVATE_PES || c == StreamClass::other) return {};
    if (c == StreamClass::video) return {0x05, 0x04, 'H', 'E', 'V', 'C'};
    return {0x05, 0x04, 'O', 'p', 'u', 's'};
}

// The PES header of a PES record (PTS, and DTS when it had one), its record tag after
// it; `len` is PES_packet_length. Returns the header's bytes.
int pes_head(const TraceRecord& r, uint32_t index, int len, uint8_t* out) {
    const bool dts = r.dts_minus_pts_90k != 0;
    const int64_t pts = (int64_t)(r.value & (uint64_t)(PTS_WRAP - 1));
    out[0] = 0x00;
    out[1] = 0x00;
    out[2] = 0x01;
    out[3] = stream_id(trace_class(r.flags));
    out[4] = (uint8_t)(len >> 8);
    out[5] = (uint8_t)len;
    out[6] = 0x80;
    out[7] = dts ? 0xC0 : 0x80;
    out[8] = dts ? 10 : 5;
    out[9] = dts ? 0x30 : 0x20;
    write_pes_ts_field(out + 9, pts);
    int n = 14;
    if (dts) {
        out[14] = 0x10;
        write_pes_ts_field(out + 14, pts + r.dts_minus_pts_90k);   // mod 2^33 in the field
        n = 19;
    }
    std::memcpy(out + n, kMagic, 4);
    put_le(out + n + 4, index, 4);
    return n;
}

}  // namespace

bool trace_pes_tag(const uint8_t* payload, size_t n, uint32_t* index) {
    if (n < TRACE_PES_TAG_BYTES || std::memcmp(payload, kMagic, 4) != 0) return false;
    *index = (uint32_t)get_le(payload + 4, 4);
    return true;
}

TracePlayer::TracePlayer(std::vector<TraceRecord> records, int64_t outage_ns)
    : recs_(std::move(records)), outage_(std::max<int64_t>(outage_ns, 2)), used_(8192, 0), cc_(8192, 0) {
    for (const TraceRecord& r : recs_) used_[r.pid & 0x1FFF] = 1;
    used_[PID_PAT] = used_[PID_NULL] = 1;
    for (size_t i = 0; i < recs_.size();) {
        const TraceRecord& r = recs_[i];
        if (r.kind == TraceKind::psi) {
            // One table: a PCR record, then its ES, as record_psi writes it.
            const uint64_t program = r.value & 0xFFFF;
            size_t j = i + 1;
            while (j < recs_.size() && recs_[j].kind == TraceKind::psi && !(recs_[j].value & TRACE_PSI_PCR) &&
                   (recs_[j].value & 0xFFFF) == program)
                j++;
            add_table(i, j - i);
            i = j;
            continue;
        }
        if (r.kind == TraceKind::pcr) at(r.arrival_ns).items.push_back(Item{Op::pcr, 0, (uint32_t)i, 0});
        else if (r.kind == TraceKind::pes) add_pes(i);
        else if (r.kind == TraceKind::outage) add_outage(r);
        else misplaced_++;
        i++;
    }
}

TracePlayer::Buf& TracePlayer::at(int64_t arrival) {
    if (!bufs_.empty() && bufs_.back().arrival == arrival) return bufs_.back();
    fill_to(arrival);
    bufs_.push_back(Buf{arrival, {}});
    return bufs_.back();
}

void TracePlayer::fill_to(int64_t arrival) {
    // A silence this long without an OUTAGE record had buffers in it (payload, null
    // packets): fillers keep the restamp from seeing an outage there.
    if (bufs_.empty() || arrival <= bufs_.back().arrival) return;
    const uint64_t gap = (uint64_t)arrival - (uint64_t)bufs_.back().arrival;
    if (gap < (uint64_t)outage_) return;
    const int64_t step = outage_ / 2;
    if (gap / (uint64_t)step > (uint64_t)FILL_MAX) {
        misplaced_++;
        return;
    }
    while (arrival - bufs_.back().arrival >= outage_) bufs_.push_back(Buf{bufs_.back().arrival + step, {}});
}

int TracePlayer::free_pid() {
    // A PMT PID on no PID of the trace: the restamp ignores an ES on a PMT's PID.
    for (int pid = 0x1000; pid != 0x1000 - 1; pid = pid + 1 == PID_NULL ? 0x20 : pid + 1)
        if (!used_[pid]) {
            used_[pid] = 1;
            return pid;
        }
    return -1;
}

void TracePlayer::add_table(size_t first, size_t n) {
    const TraceRecord& h = recs_[first];
    const int program = (int)(h.value & 0xFFFF);
    Buf& b = at(h.arrival_ns);
    size_t k = 0;
    while (k < programs_.size() && programs_[k].first != program) k++;
    if (k == programs_.size()) {
        const int pmt_pid = free_pid();
        if (pmt_pid < 0) {
            misplaced_ += n;
            return;
        }
        programs_.push_back({program, pmt_pid});
        pmt_version_.push_back(0);
        // One PAT per buffer, listing every program known by its end.
        auto pat = std::find_if(b.items.begin(), b.items.end(), [](const Item& x) { return x.op == Op::pat; });
        if (pat != b.items.end()) pat->n = (uint32_t)programs_.size();
        else b.items.push_back(Item{Op::pat, (uint8_t)(pat_version_++ & 0x1F), 0, (uint32_t)programs_.size()});
    }
    b.items.push_back(Item{Op::pmt, (uint8_t)(pmt_version_[k]++ & 0x1F), (uint32_t)first, (uint32_t)n});
}

void TracePlayer::add_pes(size_t i) {
    const TraceRecord& r = recs_[i];
    if (bufs_.empty() || r.arrival_ns >= bufs_.back().arrival) {
        at(r.arrival_ns).items.push_back(Item{Op::pes, 0, (uint32_t)i, 0});
        return;
    }
    // Timed before the buffer it was written in: a header held for its next payload
    // packet (start_pes takes the first packet's arrival). Split it again there.
    size_t t = bufs_.size() - 1;
    while (t > 0 && bufs_[t - 1].arrival > r.arrival_ns) t--;
    bool clear = t > 0;
    for (size_t k = t; clear && k < bufs_.size(); k++)
        for (const Item& x : bufs_[k].items)
            if ((x.op == Op::pes || x.op == Op::held || x.op == Op::cont) && recs_[x.rec].pid == r.pid) clear = false;
    if (clear && bufs_[t - 1].arrival == r.arrival_ns) {
        for (const Item& x : bufs_[t - 1].items)
            if (x.op == Op::held && recs_[x.rec].pid == r.pid) clear = false;
    }
    if (!clear) {                         // no buffer to start in, or its PID came between
        misplaced_++;
        bufs_.back().items.push_back(Item{Op::pes, 0, (uint32_t)i, 0});
        return;
    }
    size_t first = t - 1;
    if (bufs_[first].arrival != r.arrival_ns) {
        bufs_.insert(bufs_.begin() + (std::ptrdiff_t)t, Buf{r.arrival_ns, {}});
        first = t;
    }
    bufs_[first].items.push_back(Item{Op::held, 0, (uint32_t)i, 0});
    bufs_.back().items.push_back(Item{Op::cont, 0, (uint32_t)i, 0});
}

void TracePlayer::add_outage(const TraceRecord& r) {
    // Written at the buffer that ended the silence: a buffer `value` before it, none
    // between, then that buffer.
    const int64_t silence = r.value > (uint64_t)INT64_MAX ? INT64_MAX : (int64_t)r.value;
    const int64_t start = r.arrival_ns >= INT64_MIN + silence ? r.arrival_ns - silence : INT64_MIN;
    if (silence < outage_ || (!bufs_.empty() && bufs_.back().arrival > start)) misplaced_++;
    if (bufs_.empty() || bufs_.back().arrival < start) at(start);
    bufs_.push_back(Buf{r.arrival_ns, {}});
}

void TracePlayer::put(const Item& it, std::vector<uint8_t>& out) {
    uint8_t p[PKT];
    if (it.op == Op::pat) {
        const std::vector<std::pair<int, int>> list(programs_.begin(), programs_.begin() + it.n);
        if (!build_pat(1, list, cc_[PID_PAT], it.version, p)) {
            misplaced_++;
            return;
        }
        cc_[PID_PAT] = (uint8_t)((cc_[PID_PAT] + 1) & 0x0F);
        out.insert(out.end(), p, p + PKT);
        return;
    }
    if (it.op == Op::pmt) {
        const TraceRecord& h = recs_[it.rec];
        const int program = (int)(h.value & 0xFFFF);
        size_t k = it.rec;
        int pcr_pid = PID_NULL;
        if (h.value & TRACE_PSI_PCR) pcr_pid = recs_[k++].pid & 0x1FFF;
        std::vector<PmtStream> es;
        for (; k < (size_t)it.rec + it.n; k++) {
            PmtStream s;
            s.pid = recs_[k].pid & 0x1FFF;
            s.stream_type = (int)((recs_[k].value >> 16) & 0xFF);
            s.es_info = es_info_for(s.stream_type, trace_class(recs_[k].flags));
            es.push_back(s);
        }
        int pmt_pid = -1;
        for (const auto& e : programs_)
            if (e.first == program) pmt_pid = e.second;
        const std::vector<uint8_t> sec = build_pmt_section(program, pcr_pid, {}, es, it.version);
        if (sec.empty()) {
            misplaced_ += it.n;
            return;
        }
        packetise_section(pmt_pid, sec, cc_[pmt_pid], out);
        return;
    }
    const TraceRecord& r = recs_[it.rec];
    const int pid = r.pid & 0x1FFF;
    const bool di = (r.flags & TRACE_FLAG_DISCONTINUITY) != 0;
    if (it.op == Op::pcr) {
        // Adaptation only: the CC of the PID's last payload packet, as a muxer writes it.
        build_pcr_packet(pid, (int64_t)(r.value % (uint64_t)PCR_MODULO), (cc_[pid] + 15) & 0x0F, di, p);
        out.insert(out.end(), p, p + PKT);
        return;
    }
    uint8_t head[32];
    std::memset(p, 0xFF, PKT);
    p[0] = SYNC_BYTE;
    p[1] = (uint8_t)((it.op == Op::cont ? 0x00 : 0x40) | (pid >> 8));
    p[2] = (uint8_t)pid;
    const uint8_t cc = cc_[pid];
    cc_[pid] = (uint8_t)((cc + 1) & 0x0F);
    if (it.op == Op::pes) {
        int off = 4;
        p[3] = (uint8_t)(0x10 | cc);
        if (di) {                         // the indicator rides in a one-byte AF
            p[3] = (uint8_t)(0x30 | cc);
            p[4] = 1;
            p[5] = 0x80;
            off = 6;
        }
        const int n = pes_head(r, it.rec, PKT - off - 6, head);
        std::memcpy(p + off, head, (size_t)n + TRACE_PES_TAG_BYTES);
    } else if (it.op == Op::held) {
        // Stuffing leaves HELD_HEAD payload bytes: the header stops short of its PTS.
        p[3] = (uint8_t)(0x30 | cc);
        p[4] = (uint8_t)(PKT - 5 - HELD_HEAD);
        p[5] = di ? 0x80 : 0x00;
        pes_head(r, it.rec, HELD_HEAD - 6 + (PKT - 4), head);
        std::memcpy(p + PKT - HELD_HEAD, head, HELD_HEAD);
    } else {
        p[3] = (uint8_t)(0x10 | cc);
        const int n = pes_head(r, it.rec, HELD_HEAD - 6 + (PKT - 4), head);
        std::memcpy(p + 4, head + HELD_HEAD, (size_t)(n - HELD_HEAD) + TRACE_PES_TAG_BYTES);
    }
    out.insert(out.end(), p, p + PKT);
}

bool TracePlayer::next(Buffer* out) {
    if (pos_ >= bufs_.size()) return false;
    const Buf& b = bufs_[pos_++];
    out->arrival_ns = b.arrival;
    out->bytes.clear();
    for (const Item& it : b.items) put(it, out->bytes);
    if (out->bytes.empty()) {
        uint8_t p[PKT];
        null_packet(0, p);
        out->bytes.insert(out->bytes.end(), p, p + PKT);
    }
    return true;
}

}  // namespace mrts
