// ts_pcr: the PCR field at its limits, the PCR-only packet bytes (moved from
// ts_psi_test; expected bytes from python ts_psi.build_pcr_packet), the
// discontinuity flag, and the egress cadence on a sparse PCR PID (WI-S0-4).
#include <cstring>
#include <vector>

#include "../ts_pcr.h"
#include "check.h"

using namespace mrts;

namespace {

using Bytes = std::vector<uint8_t>;
constexpr int64_t MS = 1'000'000;

// One packet filled with `fill`; af_len < 0 = no AF, else an AF of af_len bytes
// whose flags byte is `flags`, the rest of the AF zero.
Bytes packet(int pid, int cc, bool payload, int af_len = -1, uint8_t flags = 0,
             uint8_t fill = 0xA5) {
    Bytes p(PKT, fill);
    p[0] = SYNC_BYTE;
    p[1] = (uint8_t)((pid >> 8) & 0x1F);
    p[2] = (uint8_t)(pid & 0xFF);
    p[3] = (uint8_t)((af_len >= 0 ? 0x20 : 0) | (payload ? 0x10 : 0) | (cc & 0x0F));
    if (af_len >= 0) {
        p[4] = (uint8_t)af_len;
        if (af_len >= 1) p[5] = flags;
        for (int i = 6; i < 5 + af_len && i < PKT; i++) p[i] = 0x00;
    }
    return p;
}

PacketView view(Bytes& b) {
    PacketView v;
    parse_packet(b.data(), &v);
    return v;
}

bool same_outside(const Bytes& a, const Bytes& b, int lo, int hi) {
    for (int i = 0; i < PKT; i++)
        if ((i < lo || i >= hi) && a[i] != b[i]) return false;
    return true;
}

int64_t built_then_read(int64_t pcr) {
    uint8_t t[PKT];
    build_pcr_packet(0x100, pcr, 0, t);
    return read_pcr(t);
}

int64_t written_then_read(int64_t pcr) {
    Bytes b = packet(0x100, 0, true, 7, 0x10);
    PacketView v = view(b);
    write_pcr(v, pcr);
    return read_pcr(b.data());
}

// A write that must be refused: false from both forms, every byte unchanged.
bool refused(Bytes b) {
    const Bytes before = b;
    PacketView v = view(b);
    if (write_pcr(v, 1234567) || b != before) return false;
    return !write_pcr(b.data(), 1234567) && b == before;
}

struct Pcr { int64_t at; bool inserted; uint8_t cc; int last_payload_cc; };

}  // namespace

int main() {
    // --- the field at its limits ---------------------------------------------
    const int64_t MAX = PCR_MODULO - 1;          // 2^33 * 300 - 1
    const int64_t EXT299 = 300 * 12345 + 299;
    CHECK("PCR 0 round-trips (build, write)", built_then_read(0) == 0 && written_then_read(0) == 0);
    CHECK("PCR 2^33*300-1 round-trips (build, write)",
          built_then_read(MAX) == MAX && written_then_read(MAX) == MAX);
    CHECK("PCR with extension 299 round-trips (build, write)",
          built_then_read(EXT299) == EXT299 && written_then_read(EXT299) == EXT299);
    CHECK("the base wraps at 33 bits, as today",
          built_then_read(PCR_MODULO + 5) == 5 && written_then_read(PCR_MODULO + 5) == 5);

    // --- the PCR-only packet: today's bytes (cases moved from ts_psi_test) ----
    const int64_t pcr = 1234567890123LL;
    uint8_t pk[PKT];
    build_pcr_packet(0x00cc, pcr, 7, pk);
    CHECK("PCR packet is adaptation-only (no payload)", (pk[3] & 0x30) == 0x20);
    CHECK("PCR packet keeps the PID's cc", (pk[3] & 0x0F) == 7);
    CHECK("read_pcr round-trips build_pcr_packet", read_pcr(pk) == pcr);
    CHECK("read_pcr is -1 on a payload-only packet", read_pcr(packet(0x1FFF, 0, true).data()) == -1);
    struct Golden { int pid; int64_t pcr; int cc; uint8_t head[12]; };
    const Golden goldens[] = {
        {0x00cc, pcr, 7, {0x47, 0x00, 0xcc, 0x27, 0xb7, 0x10, 0x7a, 0xa4, 0xaf, 0x5e, 0x7e, 0x7b}},
        {0x0101, MAX, 15, {0x47, 0x01, 0x01, 0x2f, 0xb7, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0x2b}},
        {0x0065, EXT299, 3, {0x47, 0x00, 0x65, 0x23, 0xb7, 0x10, 0x00, 0x00, 0x18, 0x1c, 0xff, 0x2b}},
        {0x0100, 0, 0, {0x47, 0x01, 0x00, 0x20, 0xb7, 0x10, 0x00, 0x00, 0x00, 0x00, 0x7e, 0x00}},
    };
    bool golden_ok = true;
    for (const Golden& g : goldens) {
        uint8_t t[PKT];
        std::memset(t, 0x00, PKT);               // the builder must write every byte
        build_pcr_packet(g.pid, g.pcr, g.cc, t);
        golden_ok = golden_ok && std::memcmp(t, g.head, 12) == 0;
        for (int i = 12; i < PKT; i++) golden_ok = golden_ok && t[i] == 0xFF;
    }
    CHECK("PCR-only packets are byte-identical to python's (0xFF stuffing)", golden_ok);

    // --- discontinuity_indicator ---------------------------------------------
    uint8_t d0[PKT], d1[PKT], d4[PKT];
    build_pcr_packet(0x101, pcr, 5, false, d0);
    build_pcr_packet(0x101, pcr, 5, true, d1);
    build_pcr_packet(0x101, pcr, 5, d4);
    PacketView v0, v1;
    parse_packet(d0, &v0);
    parse_packet(d1, &v1);
    CHECK("discontinuity absent: the 4-argument packet, flags byte PCR_flag alone",
          std::memcmp(d0, d4, PKT) == 0 && d0[5] == 0x10 && !v0.af_discontinuity);
    CHECK("discontinuity set: flags byte 0x90, parses as flagged, PCR intact",
          d1[5] == 0x90 && v1.af_discontinuity && v1.af_pcr && read_pcr(d1) == pcr);
    CHECK("discontinuity changes no other byte",
          same_outside(Bytes(d0, d0 + PKT), Bytes(d1, d1 + PKT), 5, 6));
    Bytes vid = packet(0x100, 4, true, 7, 0x50);        // RAI + PCR
    const Bytes vid0 = vid;
    PacketView vv = view(vid);
    CHECK("set_discontinuity_indicator on an AF: true, bit 7 set, view updated",
          set_discontinuity_indicator(vv) && vid[5] == 0xD0 && vv.af_discontinuity);
    CHECK("set_discontinuity_indicator keeps RAI and PCR, touches only the flags byte",
          view(vid).af_rai && view(vid).af_pcr && same_outside(vid, vid0, 5, 6));
    Bytes noaf = packet(0x100, 4, true, -1, 0, 0x10);    // payload byte 5 is 0x10
    const Bytes noaf0 = noaf;
    PacketView nv = view(noaf);
    CHECK("set_discontinuity_indicator without an AF: false, bytes unchanged",
          !set_discontinuity_indicator(nv) && noaf == noaf0 && !nv.af_discontinuity);
    Bytes af0 = packet(0x100, 4, true, 0, 0, 0x25);      // AF length 0: p[5] is payload
    const Bytes af00 = af0;
    PacketView av = view(af0);
    CHECK("set_discontinuity_indicator on a 0-length AF: false, payload untouched",
          !set_discontinuity_indicator(av) && af0 == af00);

    // --- write_pcr -------------------------------------------------------------
    Bytes w = packet(0x100, 2, true, 7, 0x10);           // reserved bits written as 0
    const Bytes w0 = w;
    PacketView wv = view(w);
    uint8_t ref[PKT];
    build_pcr_packet(0x100, pcr, 2, ref);
    CHECK("write_pcr: true, reads back, changes only the six PCR bytes",
          write_pcr(wv, pcr) && read_pcr(w.data()) == pcr && same_outside(w, w0, 6, 12));
    CHECK("write_pcr encodes exactly as build_pcr_packet (reserved bits set)",
          std::memcmp(w.data() + 6, ref + 6, 6) == 0);
    Bytes raw = w0;
    CHECK("raw write_pcr writes the same bytes", write_pcr(raw.data(), pcr) && raw == w);
    CHECK("write_pcr refuses an AF without PCR_flag", refused(packet(0x100, 2, true, 7, 0x40)));
    CHECK("write_pcr refuses PCR_flag in an AF too short for the field",
          refused(packet(0x100, 2, true, 6, 0x10)));
    CHECK("write_pcr refuses a packet without an AF", refused(packet(0x100, 2, true, -1, 0, 0xFF)));

    // --- PcrScheduler ----------------------------------------------------------
    PcrScheduler s;
    CHECK("scheduler: due before the PID's first PCR, cc 0", s.due(0) && s.cc() == 0);
    const int64_t t0 = 1'000'000'007LL;
    s.saw_pcr(t0);
    CHECK("scheduler: not due right after a PCR, nor 1 ns short of 40 ms",
          !s.due(t0) && !s.due(t0 + PCR_MAX_INTERVAL_NS - 1) && !s.due(t0 - 1));
    CHECK("scheduler: due at exactly 40 ms", s.due(t0 + PCR_MAX_INTERVAL_NS));
    s.saw_pcr(t0 + 30 * MS);
    CHECK("scheduler: each PCR restarts the interval", !s.due(t0 + 69 * MS) && s.due(t0 + 70 * MS));
    s.saw_payload(9);
    const bool cc9 = s.cc() == 9;
    s.saw_payload(0x1A);
    CHECK("scheduler: cc is the last payload's, 4 bits", cc9 && s.cc() == 0x0A);

    // Sparse PCR PID: audio 0x101 is the PCR PID, PES every 64 ms, a PCR on
    // every third; video fills each other 1 ms. due() is checked before every
    // packet (the Phase 5 egress order). 21 inserted and 6 natural, by hand.
    PcrScheduler sch;
    CcTracker cct;
    std::vector<Pcr> pcrs;
    std::vector<Bytes> apid;                             // the PCR PID as sent
    bool tracker_ok = true;
    int acc = 0, vcc = 0, last_cc = -1;
    for (int ms = 0; ms < 1000; ms++) {
        const int64_t now = 5000 * MS + ms * MS;
        if (sch.due(now)) {
            Bytes t(PKT);
            build_pcr_packet(0x101, ns_to_pcr27(now), sch.cc(), false, t.data());
            sch.saw_pcr(now);
            pcrs.push_back({now, true, (uint8_t)(t[3] & 0x0F), last_cc});
            apid.push_back(t);
            tracker_ok = tracker_ok && cct.feed(view(t)) == CcTracker::Result::Ok;
        }
        Bytes p;
        if (ms % 64 == 0) {
            p = ms % 192 == 0 ? packet(0x101, acc, true, 7, 0x10) : packet(0x101, acc, true);
            PacketView v = view(p);
            if (write_pcr(v, ns_to_pcr27(now))) {
                sch.saw_pcr(now);
                pcrs.push_back({now, false, v.cc, last_cc});
            }
            sch.saw_payload(v.cc);
            last_cc = v.cc;
            acc = (acc + 1) & 0x0F;
            apid.push_back(p);
        } else {
            p = packet(0x100, vcc, true);
            vcc = (vcc + 1) & 0x0F;
        }
        tracker_ok = tracker_ok && cct.feed(view(p)) == CcTracker::Result::Ok;
    }
    int inserted = 0, natural = 0;
    bool gaps_ok = true, at_40 = true, cc_rule = true;
    for (size_t i = 0; i < pcrs.size(); i++) {
        (pcrs[i].inserted ? inserted : natural)++;
        if (i > 0) {
            const int64_t gap = pcrs[i].at - pcrs[i - 1].at;
            gaps_ok = gaps_ok && gap <= PCR_MAX_INTERVAL_NS;
            if (pcrs[i].inserted) at_40 = at_40 && gap == PCR_MAX_INTERVAL_NS;
        }
        if (pcrs[i].inserted)
            cc_rule = cc_rule && pcrs[i].cc == (pcrs[i].last_payload_cc < 0 ? 0 : pcrs[i].last_payload_cc);
    }
    // A strict receiver's rule over the PID from its first payload: payload
    // packets advance CC by one, adaptation-only packets repeat it.
    bool strict = true;
    int prev_cc = -1;
    std::vector<int64_t> on_wire;
    for (Bytes& b : apid) {
        PacketView v = view(b);
        if (prev_cc >= 0)
            strict = strict && v.cc == (v.has_payload ? ((prev_cc + 1) & 0x0F) : prev_cc);
        if (v.has_payload || prev_cc >= 0) prev_cc = v.cc;
        if (read_pcr(b.data()) >= 0) on_wire.push_back(read_pcr(b.data()));
    }
    bool stamped = on_wire.size() == pcrs.size();
    for (size_t i = 0; stamped && i < pcrs.size(); i++)
        stamped = on_wire[i] == ns_to_pcr27(pcrs[i].at);
    CHECK("cadence: 21 PCR-only packets inserted, 6 natural PCRs", inserted == 21 && natural == 6);
    CHECK("cadence: no two PCRs on the PID more than 40 ms apart", gaps_ok);
    CHECK("cadence: each insertion lands exactly 40 ms after the previous PCR", at_40);
    CHECK("cadence: an inserted packet reuses the PID's last payload CC", cc_rule);
    CHECK("cadence: the PID passes the strict CC rule and CcTracker", strict && tracker_ok && cct.lost() == 0);
    CHECK("cadence: each PCR on the wire carries its send time, in order", stamped);

    PcrScheduler dense, none;
    int dense_ins = 0, none_ins = 0;
    for (int ms = 0; ms < 1000; ms++) {
        const int64_t now = ms * MS;
        if (dense.due(now)) {
            dense_ins++;
            dense.saw_pcr(now);
        }
        if (ms % 20 == 0) dense.saw_pcr(now);
        if (none.due(now)) {
            none_ins++;
            none.saw_pcr(now);
        }
    }
    CHECK("cadence: a PCR every 20 ms needs only the start-up insertion", dense_ins == 1);
    CHECK("cadence: a PID with no PCR of its own gets one every 40 ms", none_ins == 25);

    return test_summary("ts_pcr");
}
