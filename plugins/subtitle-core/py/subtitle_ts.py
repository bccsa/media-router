"""Bus chunks → per-PES house time for the subtitle bridge: a 188-byte TS walk,
a PES assembler that gives each private PES the house time of the chunk it
began in (`subtitle_stamp_model`), and the small LRU the bridge joins demuxed
buffers through. Pure stdlib. ADR-0016 amendment 2026-10-09. `PesStamper` is
the spec of the native walk (mpegts-core/native/mrpeshouse/pes_walk.cpp).
"""
import collections
import hashlib
import threading

from subtitle_stamp_model import StampModel, chunk_reference

PKT = 188
STREAM_ID_PRIVATE_1 = 0xBD
MAX_PES_BYTES = 65536
STAMP_INDEX_SIZE = 64
# A demuxed buffer reaches its reader milliseconds after its chunk passed the
# sink probe; an entry older than this is not the one being looked up.
STAMP_MAX_AGE_MS = 5000


def iter_packets(data):
    """188-byte TS packets of a packet-aligned chunk (tsparse re-frames)."""
    for i in range(0, len(data) - PKT + 1, PKT):
        if data[i] == 0x47:
            yield data[i:i + PKT]


def packet_pid(pkt):
    return ((pkt[1] & 0x1F) << 8) | pkt[2]


def has_pcr(pkt):
    return bool(pkt[3] & 0x20) and pkt[4] >= 7 and bool(pkt[5] & 0x10)


def payload_offset(pkt):
    """Offset of the packet payload, or PKT when it carries none."""
    afc = (pkt[3] >> 4) & 0x3
    if not afc & 0x1:
        return PKT
    off = 4 + (1 + pkt[4] if afc & 0x2 else 0)
    return min(off, PKT)


def parse_pes_header(p):
    """PES start `p` → (stream_id, pts90k|None, header_len, payload_len|None),
    or None when `p` is not a PES with the optional header (PSI, padding)."""
    if len(p) < 9 or p[0] != 0 or p[1] != 0 or p[2] != 1:
        return None
    sid = p[3]
    if sid in (0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF) or (p[6] & 0xC0) != 0x80:
        return None
    hdr = 9 + p[8]
    pts = None
    if p[7] & 0x80 and len(p) >= 14:
        pts = (((p[9] >> 1) & 0x07) << 30) | (p[10] << 22) | ((p[11] >> 1) << 15) \
            | (p[12] << 7) | (p[13] >> 1)
    plen = (p[4] << 8) | p[5]
    need = 6 + plen - hdr if plen and 6 + plen >= hdr else None
    return sid, pts, hdr, need


class PesStamper:
    """Assembles PES of stream_id `sid` (optionally only `pids`) across chunks
    and gives each the house time of the chunk it STARTED in."""

    def __init__(self, sid=STREAM_ID_PRIVATE_1, pids=None):
        self.sid = sid
        self.pids = set(pids) if pids is not None else None
        self.pcr_pid = None
        self._open = {}         # pid -> [pts, house_ms, payload bytearray, need]
        self.model = StampModel()

    def feed(self, data, chunk_ms):
        """→ [(pid, payload bytes, house_ms|None)] for every PES completed in
        this chunk; None = no mapping known when it started."""
        done, started, heads = [], [], []
        for pkt in iter_packets(data):
            pid = packet_pid(pkt)
            if pkt[3] & 0x20 and has_pcr(pkt):
                self.pcr_pid = pid
            off = payload_offset(pkt)
            if off >= PKT:
                continue
            if not pkt[1] & 0x40:
                rec = self._open.get(pid)
                if rec is not None:
                    self._add(pid, rec, pkt[off:], done)
                continue
            hdr = parse_pes_header(pkt[off:])
            if hdr is None:
                continue
            sid, pts, hlen, need = hdr
            prev = self._open.pop(pid, None)
            if prev is not None and prev[3] is None:
                done.append((pid, prev))        # unbounded PES ends at the next one
            if pts is not None:
                heads.append((pid, sid, pts))
            if sid != self.sid or (self.pids is not None and pid not in self.pids):
                continue
            rec = [pts, None, bytearray(), need]
            self._open[pid] = rec
            started.append(rec)
            self._add(pid, rec, pkt[off + hlen:], done)
        self.model.observe(chunk_ms, *chunk_reference(heads, self.pcr_pid))
        for rec in started:
            rec[1] = self.model.house(rec[0])
        return [(pid, bytes(rec[2]), rec[1]) for pid, rec in done]

    def _add(self, pid, rec, chunk, done):
        rec[2] += chunk
        if rec[3] is not None and len(rec[2]) >= rec[3]:
            del rec[2][rec[3]:]
            self._open.pop(pid, None)
            done.append((pid, rec))
        elif len(rec[2]) > MAX_PES_BYTES:
            self._open.pop(pid, None)            # lost its end: drop, never grow


def klv_span(data):
    """The KLV triplet at the start of `data` (16-byte key + BER length +
    value), or `data` itself when it does not parse — the join key ignores
    anything a demuxer might append."""
    data = bytes(data)
    i = 16
    if len(data) <= i:
        return data
    n = data[i]
    i += 1
    if n & 0x80:
        k = n & 0x7F
        if k == 0 or k > 4 or i + k > len(data):
            return data
        n = int.from_bytes(data[i:i + k], "big")
        i += k
    return data[:i + n] if i + n <= len(data) else data


def payload_key(data):
    return hashlib.sha1(bytes(data)).digest()


class StampIndex:
    """payload key → (house_ms|None, recorded at). LRU of `size` keys; the
    latest record wins (re-sends of one cue carry one PES PTS, so one time)."""

    def __init__(self, size=STAMP_INDEX_SIZE, max_age_ms=STAMP_MAX_AGE_MS):
        self.size, self.max_age_ms = size, max_age_ms
        self._d = collections.OrderedDict()
        self._lock = threading.Lock()   # recorded on the demux thread, read on the reader's

    def record(self, key, house_ms, now_ms):
        with self._lock:
            self._d[key] = (house_ms, now_ms)
            self._d.move_to_end(key)
            while len(self._d) > self.size:
                self._d.popitem(last=False)

    def lookup(self, key, now_ms):
        """house_ms of `key`, or None (unknown, unmapped or stale)."""
        with self._lock:
            hit = self._d.get(key)
        if hit is None:
            return None
        house_ms, at = hit
        if now_ms is not None and at is not None and now_ms - at > self.max_age_ms:
            return None
        return house_ms

    def __len__(self):
        return len(self._d)
