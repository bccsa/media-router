#include "ts_trace.h"

#include <cstring>

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
    f_ = std::fopen(path.c_str(), "wb");
    if (!f_) return false;
    count_ = 0;
    uint8_t h[TRACE_HEADER_BYTES];
    encode_trace_header(0, h);
    ok_ = std::fwrite(h, 1, sizeof h, f_) == sizeof h;
    return ok_;
}

void TraceWriter::write(const TraceRecord& r) {
    if (!f_) return;
    uint8_t b[TRACE_RECORD_BYTES];
    encode_trace_record(r, b);
    if (std::fwrite(b, 1, sizeof b, f_) != sizeof b) ok_ = false;
    count_++;
}

bool TraceWriter::close() {
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

}  // namespace mrts
