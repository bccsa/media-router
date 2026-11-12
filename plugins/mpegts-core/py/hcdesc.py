#!/usr/bin/env python3
"""The house-time descriptor (plan ch. 9 part 4.3, B-219) mirrored for the egress writer's Python
reference (egress_core.py, B-221): a registration descriptor 'MRHT' in a PMT's program_info loop.
mrts::hcdesc (native/mrts/ts_hcdesc.{h,cpp}) is the codec; this copy is pinned against its test
vectors in egress_ref_test.py and never loaded at runtime.
"""
from dataclasses import dataclass, replace

TAG = 0x05
FORMAT = 0x4D524854                               # 'MRHT' (OQ-37)
VERSION = 1
LENGTH = 32
MIN_LENGTH = 24
BYTES = 2 + LENGTH
SYNC_NONE, SYNC_NTP, SYNC_SNTP, SYNC_PTP = 0, 1, 2, 3
ERROR_CLASS_UNKNOWN = 0xFF
ERROR_CLASS_MAX = 31
ALL_ONES = (1 << 64) - 1


@dataclass(frozen=True)
class HouseTimeDecl:
    version: int = VERSION
    house_time_tai: bool = False
    disciplined: bool = False
    traceable: bool = False
    ptp_valid: bool = False
    sync_source: int = SYNC_NONE
    tai_utc_offset_s: int = 0
    ptp_domain: int = 0xFF
    clock_error_class: int = ERROR_CLASS_UNKNOWN
    gm_identity: int = ALL_ONES
    epoch_seq: int = 0
    d_e_90k: int = 0
    timeline_id: int = 0

    def but(self, **kw):
        return replace(self, **kw)


def _is_mrht(b, i, n):
    return b[i] == TAG and n >= 4 and int.from_bytes(b[i + 2:i + 6], "big") == FORMAT


def encode(d):
    """All 34 bytes; hc_version is always VERSION, ptp_valid 0 writes 0xFF and all ones."""
    flags = ((0x80 if d.house_time_tai else 0) | (0x40 if d.disciplined else 0)
             | (0x20 if d.traceable else 0) | (0x10 if d.ptp_valid else 0) | 0x0F)
    out = bytearray([TAG, LENGTH]) + FORMAT.to_bytes(4, "big")
    out += bytes([VERSION, flags, d.sync_source & 0xFF, d.tai_utc_offset_s & 0xFF,
                  (d.ptp_domain & 0xFF) if d.ptp_valid else 0xFF])
    out += (d.gm_identity if d.ptp_valid else ALL_ONES).to_bytes(8, "big")
    out += bytes([d.clock_error_class & 0xFF])
    out += (d.epoch_seq & 0xFFFF).to_bytes(2, "big")
    out += (d.d_e_90k & 0xFFFFFFFF).to_bytes(4, "big")
    out += (d.timeline_id & ALL_ONES).to_bytes(8, "big")
    return bytes(out)


def decode(b):
    """The declaration of the descriptor starting at b[0], or None (mrts's rules)."""
    if len(b) < 2:
        return None
    dl = b[1]
    if dl < MIN_LENGTH or 2 + dl > len(b) or not _is_mrht(b, 0, dl) or b[6] < 1:
        return None
    f = b[7]
    return HouseTimeDecl(
        version=b[6], house_time_tai=bool(f & 0x80), disciplined=bool(f & 0x40),
        traceable=bool(f & 0x20), ptp_valid=bool(f & 0x10), sync_source=b[8],
        tai_utc_offset_s=b[9], ptp_domain=b[10], gm_identity=int.from_bytes(b[11:19], "big"),
        clock_error_class=b[19], epoch_seq=int.from_bytes(b[20:22], "big"),
        d_e_90k=int.from_bytes(b[22:26], "big"),
        timeline_id=int.from_bytes(b[26:34], "big") if dl >= LENGTH else 0)


def _entries(pi):
    i, n = 0, len(pi)
    while i + 2 <= n and i + 2 + pi[i + 1] <= n:
        yield i, pi[i + 1]
        i += 2 + pi[i + 1]


def find_in(pi):
    """The first MRHT of the loop that decodes, past any other registration, or None."""
    pi = bytes(pi)
    for i, _ in _entries(pi):
        d = decode(pi[i:])
        if d is not None:
            return d
    return None


def find_all(pi):
    """Every MRHT entry of the loop (decodable or not), for the tests' once-only check."""
    pi = bytes(pi)
    return [pi[i:i + 2 + n] for i, n in _entries(pi) if _is_mrht(pi, i, n)]


def strip_from(pi):
    """The loop without any MRHT, every other byte kept in order, an overrunning tail verbatim."""
    pi = bytes(pi)
    out = bytearray()
    end = 0
    for i, n in _entries(pi):
        if not _is_mrht(pi, i, n):
            out += pi[i:i + 2 + n]
        end = i + 2 + n
    return bytes(out + pi[end:])


def error_class(err_us):
    """ceil(log2(max(1, err_us))) saturating at 31; None or negative = unknown (0xFF)."""
    if err_us is None or not err_us >= 0:
        return ERROR_CLASS_UNKNOWN
    c = 0
    while c < ERROR_CLASS_MAX and (1 << c) < err_us:
        c += 1
    return c


def parse_gm(s):
    """pmc's 2ccf67.fffe.76e669 or eight pairs split by ':' or '-', either case; None otherwise."""
    pmc = len(s) == 18 and s[6] == "." and s[11] == "."
    pairs = len(s) == 23 and s[2] in ":-"
    if not pmc and not pairs:
        return None
    v = 0
    for i, c in enumerate(s):
        if (i in (6, 11)) if pmc else (i % 3 == 2):
            if c != s[6 if pmc else 2]:
                return None
            continue
        if c not in "0123456789abcdefABCDEF":
            return None
        v = (v << 4) | int(c, 16)
    return v


def gm_text(gm):
    return "-".join("%02X" % ((gm >> (8 * i)) & 0xFF) for i in range(7, -1, -1))


def timeline_text(tid):
    return "%016x" % tid


def parse_timeline_text(s):
    if len(s) != 16 or any(c not in "0123456789abcdef" for c in s):
        return None
    return int(s, 16)
