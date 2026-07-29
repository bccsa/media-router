// C++ port of ts_split.py — packet-level MPEG-TS splitter core.
//
// Splits one muxed TS into per-PID single-ES SPTS outputs by forwarding the
// selected PIDs' 188-byte packets AS THEY ARRIVE — no PES assembly, no
// demuxer round-trip, so output cadence inherits the wire cadence. Per-output
// SPTS surgery: fresh PAT + single-ES PMT carousel (source ES descriptors
// carried verbatim; version bump on identity change), master-PCR re-injection
// for outputs off the source's PCR PID, ES packets byte-identical. See
// ts_split.py for the full protocol commentary; behavior is parity-locked.
#pragma once
#include <cstdint>
#include <functional>
#include <optional>
#include <utility>
#include <vector>

#include "ts_psi.h"
#include "ts_video_info.h"

namespace mrts {

constexpr int SPLIT_PMT_PID = 0x1000;
constexpr int SPLIT_PSI_INTERVAL_PKTS = 40;
constexpr int64_t SPLIT_PCR_MIN_TICKS = PCR_HZ / 100;   // >= 10 ms between injected PCRs

struct SplitterCallbacks {
    // Source PMT first parsed or changed: full stream list + pcr pid +
    // per-pid raw descriptor loops (verbatim).
    std::function<void(const std::vector<std::pair<int, int>>& streams, int pcr_pid,
                       const std::vector<std::pair<int, std::vector<uint8_t>>>& es_info)>
        on_discovered;
    // Fires once per feed() call that had to resync, with the dropped bytes.
    std::function<void(long long dropped)> on_desync;
    // A video PID's SPS first parsed or changed (status reporting only).
    std::function<void(int pid, const VideoInfo& info)> on_videoinfo;
};

// One per-PID SPTS output: PSI carousel + optional PCR re-injection.
class SplitOutput {
  public:
    SplitOutput(int pid, int ts_id, int stream_type)
        : pid(pid), ts_id(ts_id), stream_type(stream_type) {}

    // Adopt the source-discovered stream identity; a change bumps the PMT
    // version (mod 32) and forces the carousel before the next ES packet.
    void update(int stype, const std::vector<uint8_t>& info);

    // Join one input buffer's worth of this PID's packets into `out`,
    // prefixed by due PSI / PCR packets. master_pcr < 0 = none yet.
    void batch(const uint8_t* const* chunks, size_t count, int64_t master_pcr,
               std::vector<uint8_t>& out);

    const int pid;
    const int ts_id;
    int stream_type;
    std::vector<uint8_t> es_info;
    int version = 0;
    bool needs_pcr = false;
    int cc_pat = 0, cc_pmt = 0;
    int last_cc = 0;                 // last payload CC (stamped onto PCR-only pkts)
    int64_t last_pcr = -1;
    int since_psi = SPLIT_PSI_INTERVAL_PKTS;   // force PSI before the first ES
};

// Single-pass PID router. feed(data) -> per-enabled-output joined SPTS bytes.
class SplitterCore {
  public:
    struct OutputSpec {
        int pid;
        int stream_type = -1;        // -1 = unknown (defaults to AVC, python parity)
    };
    struct Batch {
        int pid;
        const std::vector<uint8_t>* data;   // valid until the next feed()
    };

    SplitterCore(int ts_id, const std::vector<OutputSpec>& outputs,
                 SplitterCallbacks callbacks = {});

    // Gate which outputs are produced (wired-only mode). A re-enabled pid
    // gets its PSI carousel and PCR re-injection forced.
    void set_enabled(const std::vector<int>& pids);

    // Declare a new output PID on a RUNNING core (the child's `add_output`
    // verb): a PID discovered after startup gets its output without the
    // respawn the fixed `--out` set would otherwise require. Returns false if
    // the pid is already an output or out of range. The new output starts
    // DISABLED (nothing is wired to it yet) and adopts the identity discovery
    // has already established, so its first batch advertises the right
    // stream_type/descriptors. Never call during feed() — the poll loop
    // serialises control verbs against routing.
    bool add_output(int pid, int stream_type = -1);

    // Route one input buffer. Returned batches are invalidated by the next
    // feed() call. Order = first-appearance order in the buffer.
    const std::vector<Batch>& feed(const uint8_t* data, size_t len);

    long long desync_bytes() const { return desync_bytes_; }
    int pcr_pid() const { return pcr_pid_; }
    const PsiDiscovery& discovery() const { return disc_; }

  private:
    void apply_discovery();

    int ts_id_;
    std::vector<SplitOutput> outputs_;
    int16_t out_lut_[8192];          // pid -> outputs_ index, -1 = none
    std::vector<bool> enabled_;      // per outputs_ index
    int16_t probe_lut_[8192];        // pid -> probes_ index, -1 = none
    std::vector<VideoInfoProbe> probes_;
    PsiDiscovery disc_;
    SplitterCallbacks cb_;
    int pcr_pid_ = -1;
    int64_t master_pcr_ = -1;
    long long desync_bytes_ = 0;
    std::vector<uint8_t> rem_;       // unaligned tail carried into the next feed
    // Per-feed scratch (reused across calls):
    std::vector<uint8_t> joined_;    // rem_ + data when rem_ is non-empty
    std::vector<std::vector<const uint8_t*>> buckets_;
    std::vector<std::vector<uint8_t>> batch_bufs_;
    std::vector<TsPacket> psi_pkts_;
    std::vector<Batch> result_;
};

}  // namespace mrts
