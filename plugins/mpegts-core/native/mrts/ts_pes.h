// PES packets (ISO 13818-1 2.4.3.6-2.4.3.7): header parse, in-place timestamp
// rewrite (also of a header split over two packets), and reassembly of whole
// PES on every selected PID.
#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <vector>

#include "ts_packet.h"

namespace mrts {

// Lenient as the readers it replaces: a PES_header_data_length too short for
// the flagged fields, or a PES_packet_length shorter than the header (read as
// unbounded, as mrpeshouse does), does not reject it.
struct PesHeader {
    uint8_t sid = 0;
    int64_t pts = -1, dts = -1;           // raw 33-bit, -1 = absent
    int     header_len = 0;               // 9 + PES_header_data_length, 6 without
                                          // an optional header; 0 = not yet known
    int64_t payload_len = -1;             // bytes after the header, -1 = unbounded
                                          // (PES_packet_length 0)
    bool    data_alignment = false;
    int     pts_off = -1, dts_off = -1;   // byte offsets of the 5-byte
                                          // fields from the PES start
    bool    complete = false;             // the whole header was present
};
// Parses from a PES start (00 00 01); `n` = bytes available. Ids without an
// optional header (0xBC, 0xBE, 0xBF, 0xF0-0xF2, 0xF8, 0xFF) give header_len 6.
// False: not a PES start. Cut short by `n`: true, !complete, what `n` covers.
bool parse_pes_header(const uint8_t* pes, size_t n, PesHeader* out);

// The 5-byte field writer (was ts_timeline's write_ts_field, byte for byte):
// keeps the 4-bit prefix, writes the marker bits '1' and v33 mod 2^33.
void write_pes_ts_field(uint8_t* field, int64_t v33);
// Rewrites PTS and, when present, DTS in place. False, nothing written, when
// the header is not complete in this packet (see PesHeaderSpan).
bool rewrite_pes_timestamps(PacketView& v, const PesHeader& h,
                            int64_t pts33, int64_t dts33);

// For rewriters: a PUSI packet whose PES header spills into its PID's next
// payload packet (an AF can leave < 19 bytes) is held until then, both rewritten
// and released in order. One per PID; other PIDs and payload-less packets pass.
class PesHeaderSpan {
  public:
    // Offer every packet first. True on the held PID's next payload packet: emit
    // `first` (the held one), then `v`, both rewritten by ts(joined PesHeader,
    // int64_t& pts33, int64_t& dts33 preset to it) unless a CC gap or PUSI cut it.
    template <class F> bool complete(PacketView& v, uint8_t first[PKT], F&& ts);
    // Then: a PUSI packet whose header continues past it is copied and held (true,
    // emit nothing for `v` now); false: rewrite `v` in place as usual.
    bool hold(const PacketView& v);
    // EOS: the held packets, unchanged, appended in hold order.
    void flush(std::vector<uint8_t>& out);
    void reset() {                        // flush-stop: held packets are dropped
        held_.clear();
        dup_pid_ = -1;
    }
    bool held(int pid) const { return find(pid) < held_.size(); }
    // The header `v` would complete for its PID's held packet, read without completing it;
    // false where complete() would release that packet unrewritten (B-185).
    bool joined(const PacketView& v, PesHeader* h) const;
    uint64_t spans() const { return spans_; }    // headers rewritten across two packets
    uint64_t broken() const { return broken_; }  // held packets released unrewritten

  private:
    struct Held {
        int pid, payload_off;
        uint8_t cc;
        uint8_t b[PKT];
    };
    size_t find(int pid) const;
    bool read(const Held& s, const PacketView& v, PesHeader* h, bool* dup) const;
    bool join(const Held& s, const PacketView& v, PesHeader* h);
    void write(Held& s, PacketView& v, const PesHeader& h, int64_t pts33, int64_t dts33);
    void release(size_t i, uint8_t* first);

    std::vector<Held> held_;
    int dup_pid_ = -1;                    // a duplicate join() saw: hold() lets it pass
    uint8_t dup_cc_ = 0;
    uint64_t spans_ = 0, broken_ = 0;
};

template <class F>
bool PesHeaderSpan::complete(PacketView& v, uint8_t first[PKT], F&& ts) {
    if (held_.empty() || v.payload_off >= PKT) return false;
    const size_t i = find(v.pid);
    if (i == held_.size()) return false;
    PesHeader h;
    if (join(held_[i], v, &h)) {
        int64_t pts33 = h.pts, dts33 = h.dts;
        ts(static_cast<const PesHeader&>(h), pts33, dts33);
        write(held_[i], v, h, pts33, dts33);
        spans_++;
    } else {
        broken_++;
    }
    release(i, first);
    return true;
}

struct PesUnit {
    int pid = -1;
    PesHeader hdr;
    std::vector<uint8_t> payload;         // empty when keep_payload=false
    size_t size = 0;                      // payload bytes, kept or not
    bool discont = false;                 // the PID lost or skipped data just before it
    uint64_t seq = 0;                     // per-PID count of PES starts: a gap = drops
};
// Reassembles the PES of every selected PID: bounded ones complete at their
// length, unbounded ones at the next PUSI or flush(). Drops are counted, never
// grown past (R9); keep_payload=false indexes the headers without a copy.
class PesAssembler {
  public:
    struct Config { size_t max_bytes = 32u << 20; bool keep_payload = true; };
    PesAssembler() = default;
    explicit PesAssembler(const Config& cfg) : cfg_(cfg) {}
    void select(int pid, bool on);        // off forgets the PID, an open unit too
    // `cc` = CcTracker::feed(v). A Duplicate is skipped; Lost and Reset (the
    // discontinuity flag lets CC jump, so it can hide a loss) drop the open unit.
    void feed(const PacketView& v, CcTracker::Result cc,
              std::vector<PesUnit>& out);
    void flush(std::vector<PesUnit>& out);  // EOS / PMT change
    // The PID's open unit closed as at its next PUSI: an unbounded one out, a cut one dropped.
    void close(int pid, std::vector<PesUnit>& out);
    void reset();                           // open units dropped; seq, counters go on
    std::vector<int> selected() const;      // the selected PIDs, ascending
    uint64_t oversize() const { return oversize_; }      // payload past max_bytes
    uint64_t dropped_cc() const { return dropped_cc_; }  // open units cut by Lost/Reset
    // Units dropped otherwise: no PES at a PUSI, or a header or declared length
    // cut short by the next PUSI or flush().
    uint64_t malformed() const { return malformed_; }

  private:
    struct Pid {
        PesUnit unit;                     // the open one; hdr valid once have_hdr
        std::vector<uint8_t> head;        // its header bytes while incomplete
        size_t bytes = 0;                 // its payload so far, kept or not
        uint64_t next_seq = 0;
        bool open = false, have_hdr = false;
        bool lost = false;                // the next unit is discont
        bool started = false;             // until a PUSI, payload is a mid-PES join
    };
    void begin(Pid& s, int pid, const uint8_t* p, size_t n, std::vector<PesUnit>& out);
    void add(Pid& s, const uint8_t* p, size_t n, std::vector<PesUnit>& out);
    void open_body(Pid& s, const PesHeader& h);
    void body(Pid& s, const uint8_t* p, size_t n, std::vector<PesUnit>& out);
    void close(Pid& s, std::vector<PesUnit>& out);
    void emit(Pid& s, std::vector<PesUnit>& out);
    void drop(Pid& s);

    Config cfg_;
    std::map<int, Pid> pids_;
    uint64_t oversize_ = 0, dropped_cc_ = 0, malformed_ = 0;
};

}  // namespace mrts
