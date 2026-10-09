"""Shared by the subtitle-core python suites: `check`, the ONE independent TS
reference encoder (`pes`, `packets`, `pat` — deliberately not `subtitle_pack`,
whose own oracle is the mpegtsmux byte fixtures in subtitle_pack_test.py), and
the mpegts-core python dir (a declared dependency, resolved the way
unixfdbus-core's test client resolves it).
"""
import os
import sys

MPEGTS_CORE_PY = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "mpegts-core", "py"))


def use_mpegts_core():
    """Make plugins/mpegts-core/py importable (ts_timeline, ts_psi)."""
    if MPEGTS_CORE_PY not in sys.path:
        sys.path.append(MPEGTS_CORE_PY)


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


def pes(sid, pts, payload):
    p = pts & ((1 << 33) - 1)
    ts_b = bytes([0x21 | ((p >> 29) & 0x0E), (p >> 22) & 0xFF, ((p >> 14) & 0xFE) | 1,
                  (p >> 7) & 0xFF, ((p << 1) & 0xFE) | 1])
    body = bytes([0x84, 0x80, 5]) + ts_b + payload
    return b"\x00\x00\x01" + bytes([sid]) + len(body).to_bytes(2, "big") + body


def packets(pid, data, pcr=None):
    """TS packets for one PES: PUSI on the first, PCR there if asked, the last
    one stuffed through its adaptation field."""
    out, first, cc = [], True, 0
    while True:
        af = bytes([0x10]) + ((pcr << 15) | 0x7E00).to_bytes(6, "big") if first and pcr is not None else b""
        has_af = bool(af)
        room = 184 - (1 + len(af) if has_af else 0)
        if len(data) < room:
            total = 184 - len(data)             # adaptation field incl. its length byte
            if not has_af:
                af = b"" if total == 1 else b"\x00"
            af += b"\xff" * (total - 1 - len(af))
            has_af, chunk, data = True, data, b""
        else:
            chunk, data = data[:room], data[room:]
        hdr = bytes([0x47, (0x40 if first else 0) | (pid >> 8), pid & 0xFF,
                     (0x30 if has_af else 0x10) | (cc & 0xF)])
        pkt = hdr + (bytes([len(af)]) + af if has_af else b"") + chunk
        assert len(pkt) == 188, len(pkt)
        out.append(pkt)
        first, cc = False, cc + 1
        if not data:
            return out


def pat():
    body = bytes([0x00, 0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00])
    return bytes([0x47, 0x40, 0x00, 0x10]) + body + b"\xff" * (184 - len(body))
