// Arrival traces, `.stct` (WI-P1-2): an ingest's timing evidence, the PCR and PES
// headers with the house time they arrived, so the virtual STC and the restamp's
// mapping replay bit-exactly off the device.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

namespace mrts {

// A 16-byte header {"STCT", u32 version, u64 record count}, then 24-byte records,
// all little-endian. The count is patched on close: 0 in a file whose writer died.
constexpr uint32_t TRACE_VERSION = 1;
constexpr size_t TRACE_HEADER_BYTES = 16;
constexpr size_t TRACE_RECORD_BYTES = 24;

enum class TraceKind : uint8_t { pcr = 1, pes = 2, psi = 3, outage = 4 };

// What the restamp keys on per PID: video guards on DTS, and the degraded mode's
// reference PID is the first video, else the first audio PID.
enum class StreamClass : uint8_t { other = 0, video = 1, audio = 2 };

// flags: bit 0 the packet's discontinuity_indicator, bits 1-2 the stream class.
constexpr uint8_t TRACE_FLAG_DISCONTINUITY = 0x01;
inline uint8_t trace_flags(bool discontinuity, StreamClass c) {
    return (uint8_t)((discontinuity ? TRACE_FLAG_DISCONTINUITY : 0) | ((uint8_t)c << 1));
}
inline StreamClass trace_class(uint8_t flags) { return (StreamClass)((flags >> 1) & 0x03); }

// PSI records: at each PMT change, one per PID of the program's table, the PCR
// PID's first (TRACE_PSI_PCR set, 0x1FFF without a PCR), then the ES in PMT order.
constexpr uint64_t TRACE_PSI_PCR = 1ULL << 32;
inline uint64_t trace_psi_value(int program_number, int stream_type, bool pcr_pid) {
    return (uint64_t)(program_number & 0xFFFF) | ((uint64_t)(stream_type & 0xFF) << 16) |
           (pcr_pid ? TRACE_PSI_PCR : 0);
}

struct TraceRecord {
    int64_t arrival_ns = 0;
    // PCR: the 27 MHz PCR; PES: the 33-bit PTS; both raw, as on the wire.
    // PSI: trace_psi_value. OUTAGE: the silence it ended, ns.
    uint64_t value = 0;
    uint16_t pid = 0;
    TraceKind kind = TraceKind::pcr;
    uint8_t flags = 0;
    int32_t dts_minus_pts_90k = 0;        // PES: fold33(DTS - PTS); 0 without a DTS
    bool operator==(const TraceRecord& o) const {
        return arrival_ns == o.arrival_ns && value == o.value && pid == o.pid && kind == o.kind &&
               flags == o.flags && dts_minus_pts_90k == o.dts_minus_pts_90k;
    }
};

void encode_trace_header(uint64_t count, uint8_t out[TRACE_HEADER_BYTES]);
void encode_trace_record(const TraceRecord& r, uint8_t out[TRACE_RECORD_BYTES]);
TraceRecord decode_trace_record(const uint8_t in[TRACE_RECORD_BYTES]);

class TraceWriter {
  public:
    TraceWriter() = default;
    ~TraceWriter() { close(); }
    TraceWriter(const TraceWriter&) = delete;
    TraceWriter& operator=(const TraceWriter&) = delete;
    bool open(const std::string& path);   // creates or truncates; the header says 0 records
    // Keeps the records in memory instead (records()): a replay recorded again, to
    // compare with the trace it played.
    void open_memory();
    void write(const TraceRecord& r);
    bool close();                          // patches the count; false after any I/O error
    bool is_open() const { return f_ != nullptr || memory_; }
    uint64_t count() const { return count_; }
    const std::vector<TraceRecord>& records() const { return mem_; }

  private:
    std::FILE* f_ = nullptr;
    bool memory_ = false;
    std::vector<TraceRecord> mem_;
    uint64_t count_ = 0;
    bool ok_ = true;
};

class TraceReader {
  public:
    // ok: as many records as the header says. unclosed: the count is 0 (the writer
    // died) and every record is whole. truncated: fewer records than the count, or
    // a partial record at the end. bad_header: not an .stct version 1 file.
    enum class Status { ok, unclosed, truncated, bad_header };

    TraceReader() = default;
    ~TraceReader();
    TraceReader(const TraceReader&) = delete;
    TraceReader& operator=(const TraceReader&) = delete;
    bool open(const std::string& path);   // false: no such file, or bad_header
    bool next(TraceRecord* r);            // false at the end; status() then says how it ended
    Status status() const { return status_; }
    uint64_t header_count() const { return header_count_; }
    uint64_t read_count() const { return read_; }

  private:
    std::FILE* f_ = nullptr;
    uint64_t header_count_ = 0, read_ = 0;
    Status status_ = Status::bad_header;
};

// The payload a TracePlayer gives every PES: "STCT" and the record's index (u32 LE),
// so the restamp's output says which record each PES it kept came from.
constexpr size_t TRACE_PES_TAG_BYTES = 8;
bool trace_pes_tag(const uint8_t* payload, size_t n, uint32_t* index);

// A trace played back as the TS its recorder (RestampCore::set_trace) read, so a
// RestampCore fed it makes the same clock calls and records the same trace again. Not in
// a trace, so not played: payload, CC loss, duplicates, PES without PTS, live O/trim edits.
class TracePlayer {
  public:
    struct Buffer {
        std::vector<uint8_t> bytes;       // whole packets
        int64_t arrival_ns = 0;
    };
    // outage_ns: the silence an OUTAGE record stands for (RestampCore::OUTAGE_NS).
    TracePlayer(std::vector<TraceRecord> records, int64_t outage_ns);
    bool next(Buffer* out);               // the buffers in order; false after the last
    size_t buffers() const { return bufs_.size(); }
    // Records with no place as recorded (a held header older than every buffer, an
    // outage overlapping a buffer, a kind or table no recorder writes): the replay
    // differs from the recording there.
    uint64_t misplaced() const { return misplaced_; }

  private:
    enum class Op : uint8_t { pat, pmt, pcr, pes, held, cont };
    struct Item {
        Op op;
        uint8_t version;                  // pat, pmt
        uint32_t rec;                     // the record; pmt: its table's first
        uint32_t n;                       // pmt: the table's records; pat: programs listed
    };
    struct Buf {
        int64_t arrival;
        std::vector<Item> items;          // none: one null packet
    };
    Buf& at(int64_t arrival);
    void fill_to(int64_t arrival);
    void add_table(size_t first, size_t n);
    void add_pes(size_t i);
    void add_outage(const TraceRecord& r);
    int free_pid();
    void put(const Item& it, std::vector<uint8_t>& out);

    std::vector<TraceRecord> recs_;
    int64_t outage_;
    std::vector<Buf> bufs_;
    size_t pos_ = 0;
    std::vector<std::pair<int, int>> programs_;   // (number, PMT PID), by first table
    std::vector<uint8_t> pmt_version_;            // per programs_ entry
    uint8_t pat_version_ = 0;
    std::vector<uint8_t> used_;                   // by PID: in the trace, or a PMT PID given
    std::vector<uint8_t> cc_;                     // next CC by PID
    uint64_t misplaced_ = 0;
};

}  // namespace mrts
