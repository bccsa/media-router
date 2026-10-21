// timing_pes, what is left of ts_timeline (WI-P2-2): ts_timeline_test.py's
// "timing eligibility" cases, then every stream_id and adaptation field length.
// The identity stamp's vectors live in ts_house_test.
#include <cstring>

#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "../ts_psi.h"
#include "../ts_timeline.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t PTS = 900000;            // 10 s
constexpr int64_t PCR = 123456789;

// A PUSI packet opening a PES with stream_id `sid` and a PTS on `pid`, behind an
// adaptation field of `af` bytes (-1 = none) that carries `pcr27` when >= 0.
TsPacket pes_packet(int pid, uint8_t sid, int af = -1, int64_t pcr27 = -1) {
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    t.b[0] = SYNC_BYTE;
    t.b[1] = (uint8_t)(0x40 | ((pid >> 8) & 0x1F));
    t.b[2] = (uint8_t)(pid & 0xFF);
    t.b[3] = af >= 0 ? 0x30 : 0x10;
    int off = 4;
    if (af >= 0) {
        t.b[4] = (uint8_t)af;
        if (af > 0) t.b[5] = pcr27 >= 0 ? 0x10 : 0x00;
        if (pcr27 >= 0) write_pcr(t.b, pcr27);
        off = 5 + af;
    }
    uint8_t h[14] = {0x00, 0x00, 0x01, sid, 0x00, 0x00, 0x80, 0x80, 0x05, 0x21};
    write_pes_ts_field(h + 9, PTS);
    std::memcpy(t.b + off, h, sizeof h);
    return t;
}

}  // namespace

int main() {
    // --- ts_timeline_test.py parity (timing eligibility, 2026-09-16) ----------
    const TsPacket klv = pes_packet(0x10a, 0xBD), video = pes_packet(0x65, 0xE0);
    CHECK("the fixtures hold a PES header with a PTS (the caller's precondition)",
          read_pes_pts(klv.b) == PTS && read_pes_pts(video.b) == PTS);
    auto alone = [](uint8_t sid) { return timing_pes(pes_packet(0x100, sid).b, 0x100, -1); };
    CHECK("timing_pes: video/audio yes, private no",
          alone(0xE0) && alone(0xEF) && alone(0xC0) && alone(0xDF) && !alone(0xBD) &&
              !alone(0xBF));
    CHECK("timing_pes: a private PES qualifies only on the PCR-carrying PID",
          !timing_pes(klv.b, 0x10a, -1) && timing_pes(klv.b, 0x10a, 0x10a) &&
              timing_pes(video.b, 0x65, -1));
    CHECK("timing_pes: ... not on another PID's PCR", !timing_pes(klv.b, 0x10a, 0x100));

    // --- every stream_id whose header carries a PTS ---------------------------
    int with_pts = 0, own = 0, carrier = 0, other = 0;
    bool band = true;
    for (int sid = 0; sid < 256; sid++) {
        const TsPacket p = pes_packet(0x100, (uint8_t)sid);
        if (read_pes_pts(p.b) != PTS) continue;   // 0xBC, 0xBE, 0xBF, 0xF0-0xF2, 0xF8, 0xFF
        with_pts++;
        const bool a = timing_pes(p.b, 0x100, -1);
        own += a;
        carrier += timing_pes(p.b, 0x100, 0x100);
        other += timing_pes(p.b, 0x100, 0x101) == a;
        band &= a == (sid >= 0xC0 && sid <= 0xEF);
    }
    CHECK("timing_pes: on its own exactly 0xC0-0xEF qualify, 48 of the 248 stream_ids with a PTS",
          with_pts == 248 && band && own == 48);
    CHECK("timing_pes: on the PCR carrier every one qualifies", carrier == 248);
    CHECK("timing_pes: another PID's PCR changes nothing", other == 248);

    // --- the stream_id is read where the payload starts -----------------------
    TsPacket decoy = pes_packet(0x100, 0xBD, 3);
    decoy.b[6] = decoy.b[7] = 0xE0;              // where a reader ignoring the AF looks
    CHECK("timing_pes: behind an adaptation field, never at byte 7",
          read_pes_pts(decoy.b) == PTS && !timing_pes(decoy.b, 0x100, -1));
    const TsPacket pv = pes_packet(0x100, 0xE0, 7, PCR), ps = pes_packet(0x101, 0xBD, 7, PCR);
    CHECK("timing_pes: a video PES behind its own PCR qualifies",
          read_pcr(pv.b) == PCR && read_pes_pts(pv.b) == PTS && timing_pes(pv.b, 0x100, -1));
    CHECK("timing_pes: an s302m PES behind its PCR, on that carrier only",
          read_pcr(ps.b) == PCR && read_pes_pts(ps.b) == PTS && timing_pes(ps.b, 0x101, 0x101) &&
              !timing_pes(ps.b, 0x101, -1));
    int lengths = 0;
    bool every = true;
    for (int af = -1; 5 + af + 14 <= PKT; af++) {
        const TsPacket v = pes_packet(0x100, 0xE0, af), k = pes_packet(0x100, 0xBD, af);
        every &= read_pes_pts(v.b) == PTS && read_pes_pts(k.b) == PTS &&
                 timing_pes(v.b, 0x100, -1) && !timing_pes(k.b, 0x100, -1) &&
                 timing_pes(k.b, 0x100, 0x100);
        lengths++;
    }
    CHECK("timing_pes: no adaptation field, then one of 0 to 169 bytes: the same answers",
          every && lengths == 171);

    return test_summary("ts_timeline");
}
