#!/usr/bin/env python3
"""The reference's own suite (plan ch. 7 WI-P3-1, register B-121): the cases
../native/mrts/tests/demux_core_test.cpp ports one for one, same names, same order (B-55's
pattern), on demux_core.py and the conformance fixtures (../tests/fixtures). Case 12 is every
case of tests/ts_select_test.cpp in the select configuration, on the ceil.

Run:  python3 demux_core_test.py
"""
import json
import os
import sys

import demux_core as dc
import ts_psi

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "tests", "fixtures"))
PKT = dc.PKT
SEC = dc.SEC
MS = 1000000
H = 3600 * SEC
BASE = dc.MUX_CLOCK_BASE_90K
WRAP = dc.PTS_WRAP
SELECT = dc.CAPS_302M

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


_cache = {}


def fixture(name):
    if name not in _cache:
        with open(os.path.join(FIXTURES, name + ".ts"), "rb") as f:
            _cache[name] = f.read()
    return _cache[name]


def sidecar(name):
    with open(os.path.join(FIXTURES, name + ".bus.jsonl")) as f:
        return [json.loads(line) for line in f if line.strip()]


def fixture_names():
    return sorted(f[:-3] for f in os.listdir(FIXTURES) if f.endswith(".ts"))


def replay(name_or_data, chunk=1316, media=dc.MEDIA_ALL, house_ns=None, bus=None, program=-1):
    data = fixture(name_or_data) if isinstance(name_or_data, str) else name_or_data
    return dc.replay(data, dc.Config(program=program, media=media), chunk, house_ns, bus)


def of(events, kind, pad=None):
    return [e for e in events if e.kind == kind and (pad is None or e.get("pad") == pad)]


def units_by_pid(events):
    out = {}
    for e in of(events, "unit"):
        out.setdefault(e.pid, []).append(e)
    return out


def lines(events):
    return [e.line() for e in events]


def h(s):
    return bytes.fromhex(s)


# --- the stream builder (tests/ts_select_test.cpp's Ts) -------------------------------------------

PMT_PID, PID_A, PID_V, PID_B = 0x1000, 0x41, 0x100, 0x42
TICKS_20MS = 1800                                 # 960 frames: exact in ns and in ticks
BSSD = h("050442535344")


def s302m(frames, channels=2, bits=16, fill=0):
    """A 302M payload: the AES3 header, then `frames` of channel pairs (5 bytes each at 16 bits)."""
    pair_bytes = (bits + 4) // 4
    size = frames * channels // 2 * pair_bytes
    hd = (size << 16) | ((channels // 2 - 1) << 14) | (((bits - 16) // 4) << 4)
    return hd.to_bytes(4, "big") + bytes((fill + i * 7) & 0xFF for i in range(size))


def put_ts(prefix, v):
    return bytes([(prefix << 4) | (((v >> 30) & 7) << 1) | 1, (v >> 22) & 0xFF,
                  (((v >> 15) & 0x7F) << 1) | 1, (v >> 7) & 0xFF, ((v & 0x7F) << 1) | 1])


def build_gap_packet(pid, cc, length_ns):
    """mrts::build_gap_packet: adaptation only, the length in its 8 private bytes."""
    p = bytearray(b"\xff" * PKT)
    p[0:7] = bytes([0x47, (pid >> 8) & 0x1F, pid & 0xFF, 0x20 | (cc & 0x0F), 183, 0x02, 8])
    p[7:15] = max(length_ns, 0).to_bytes(8, "big")
    return bytes(p)


class Ts:
    """A transport stream under construction: PSI, PES, raw packets, CC kept per PID."""

    def __init__(self):
        self.b = bytearray()
        self.cc = {}

    def _cc(self, pid):
        c = self.cc.get(pid, 0)
        self.cc[pid] = (c + 1) & 0xFF
        return c & 0x0F

    def pat(self, programs=None, version=0):
        self.b += ts_psi.build_pat(1, dict(programs or [(1, PMT_PID)]), self._cc(0), version)

    def pmt(self, streams, pcr_pid, version=0, pmt_pid=PMT_PID, program=1):
        self.b += ts_psi.build_pmt(pmt_pid, program, pcr_pid, streams, self._cc(pmt_pid), version)

    def psi_302m(self, pid=PID_A, version=0):
        self.pat()
        self.pmt([(pid, 0x06, BSSD)], pid, version)

    def pes(self, pid, pts33, payload, bounded=True, dts33=-1):
        """One PES on `pid`: PTS (and DTS) raw 33-bit, -1 none; unbounded: PES_packet_length 0."""
        opt = b""
        if pts33 >= 0:
            opt += put_ts(3 if dts33 >= 0 else 2, pts33)
        if dts33 >= 0:
            opt += put_ts(1, dts33)
        flags = 0 if pts33 < 0 else 0xC0 if dts33 >= 0 else 0x80
        body = bytes([0x84, flags, len(opt)]) + opt + bytes(payload)
        length = len(body) if bounded else 0
        d = bytes([0, 0, 1, 0xBD, (length >> 8) & 0xFF, length & 0xFF]) + body
        at, first = 0, True
        while first or at < len(d):
            take = min(184, len(d) - at)
            p = bytearray(PKT)
            p[0], p[1], p[2] = 0x47, (0x40 if first else 0) | ((pid >> 8) & 0x1F), pid & 0xFF
            c = self._cc(pid)
            if take == 184:
                p[3] = 0x10 | c
                p[4:] = d[at:at + 184]
            else:                                 # stuffing in the adaptation field
                af = 183 - take
                p[3] = 0x30 | c
                p[4] = af
                if af > 0:
                    p[5] = 0x00
                    p[6:5 + af] = b"\xff" * (af - 1)
                p[5 + af:] = d[at:at + take]
            self.b += p
            at += take
            first = False

    def frame(self, t, frames=960, pid=PID_A):
        """The 302M PES of house tick `t` (the formula's inverse: PES = t + 1 h, 33 bits)."""
        self.pes(pid, (t + BASE) % WRAP, s302m(frames))

    def last_cc(self, pid):
        return (self.cc.get(pid, 0) + 15) & 0x0F


def sel(program=-1):
    return dc.DemuxCore(dc.Config(select=SELECT, program=program))


def run(d, ts, now, chunk=0):
    """Feeds `ts` in `chunk`-byte pieces (0: at once) at house time `now`."""
    data = bytes(ts)
    chunk = chunk or max(len(data), 1)
    out = []
    for at in range(0, len(data), chunk):
        out += d.feed(data[at:at + chunk], False, now)
    return out


def ceil_ns(ticks):
    return dc.pts90k_to_ns_ceil(ticks)


# --- 1 classify -----------------------------------------------------------------------------------

OPUS_STEREO = ("audio/x-opus, rate=(int)48000, channels=(int)2, channel-mapping-family=(int)0, "
               "stream-count=(int)1, coupled-count=(int)1")
OPUS_51 = ("audio/x-opus, rate=(int)48000, channels=(int)6, channel-mapping-family=(int)1, "
           "stream-count=(int)4, coupled-count=(int)2, channel-mapping=(int)< 0, 4, 1, 2, 3, 5 >")
MPV = "video/mpeg, mpegversion=(int)%d, systemstream=(boolean)false"


def test_classify():
    # (row, stream type, ES loop (a fixture's where one has it), class, caps, sparse, post, lang)
    rows = [
        ("0x01 MPEG-1 video", 0x01, b"", "video", MPV % 1, False, "none", ""),
        ("0x02 MPEG-2 video (tp-mpeg2video-mp2)", 0x02, b"", "video", MPV % 2, False, "none", ""),
        ("0x1B H.264 (cap-occ's loop)", 0x1B, h("0e03c0c350"), "video", dc.CAPS_H264, False, "none", ""),
        ("0x24 HEVC (tp-hevc-aac's loop)", 0x24, h("050448455643"), "video", dc.CAPS_H265, False,
         "none", ""),
        ("0x06 + registration HEVC", 0x06, h("050448455643"), "video", dc.CAPS_H265, False, "none", ""),
        ("0x06 + registration AV1G", 0x06, h("050441563147"), "video", dc.CAPS_AV1, False, "none", ""),
        ("0x03 MPEG-1 audio (tp-mpeg2video-mp2)", 0x03, b"", "audio", dc.CAPS_MPA, False, "none", ""),
        ("0x04 MPEG-2 audio", 0x04, b"", "audio", dc.CAPS_MPA, False, "none", ""),
        ("0x0F AAC ADTS (cap-occ's loop: nor, 0x7C, 0x0E)", 0x0F, h("0a046e6f72007c035180030e03c003c0"),
         "audio", dc.CAPS_ADTS, False, "adts", "nor"),
        ("0x11 AAC LATM (tp-h264-latm)", 0x11, b"", "audio", dc.CAPS_LOAS, False, "none", ""),
        ("0x81 AC-3 (tp-h264-ac3-eac3's loop)", 0x81, h("050441432d33"), "audio", dc.CAPS_AC3, False,
         "none", ""),
        ("0x81 + 0x7A: E-AC-3, tsdemux's rule", 0x81, h("7a0100"), "audio", dc.CAPS_EAC3, False,
         "none", ""),
        ("0x06 + DVB AC-3 0x6A (system-b's loop)", 0x06, h("050441432d336a03c04208"), "audio",
         dc.CAPS_AC3, False, "none", ""),
        ("0x87 E-AC-3 (tp-h264-ac3-eac3's loop)", 0x87, h("050445414333"), "audio", dc.CAPS_EAC3,
         False, "none", ""),
        ("0x06 + DVB E-AC-3 0x7A (system-b's loop)", 0x06, h("0504454143337a0100"), "audio",
         dc.CAPS_EAC3, False, "none", ""),
        ("0x06 + Opus stereo (cap-mux-align7's loop)", 0x06, h("0a046e6f720005044f7075737f028002"),
         "audio", OPUS_STEREO, False, "opus", "nor"),
        ("0x06 + Opus 5.1 (tp-opus-51's loop)", 0x06, h("05044f7075737f028006"), "audio", OPUS_51,
         False, "opus", ""),
        ("0x06 + BSSD (cap-302m-bssd's loop)", 0x06, BSSD, "audio", dc.CAPS_302M, False, "none", ""),
        ("0x06 + teletext 0x56 (syn-wrap-33bit's loop)", 0x06, h("5605656e670988"), "private",
         dc.CAPS_TTX, True, "none", ""),
        ("0x06 + DVB subtitling 0x59 (tp-h264-dvbsub's loop: und)", 0x06, h("5908756e641000010152"),
         "subpicture", dc.CAPS_DVBSUB, True, "none", "und"),
        ("0x06 + KLVA (cap-klv-sparse's loop)", 0x06, h("05044b4c5641"), "private", dc.CAPS_KLV,
         True, "none", ""),
        ("0x15 + metadata KLVA: cells split", 0x15, h("260dffff4b4c5641ff4b4c5641000f"), "private",
         dc.CAPS_KLV, True, "klv", ""),
        ("0x06 + ID3", 0x06, h("050449443320"), "private", dc.CAPS_ID3, True, "none", ""),
        ("0x15 + metadata ID3 (tp-id3's loop)", 0x15, h("260dffff49443320ff49443320000f050449443320"),
         "private", dc.CAPS_ID3, True, "none", ""),
    ]
    for row, t, loop, cls, caps, sparse, post, lang in rows:
        es = dc.classify(t, loop)
        check("1 classify: " + row, es is not None and (es.cls, es.caps, es.sparse, es.post, es.lang) ==
              (cls, caps, sparse, post, lang))
    opus = dc.classify(0x06, h("05044f7075737f028006"))
    av1 = dc.classify(0x06, h("050441563147" "800481080c00"))
    check("1 classify: the Opus extension and the AV1 descriptor bodies kept for the element",
          opus.opus_ext == h("8006") and av1.av1_desc == h("81080c00") and av1.caps == dc.CAPS_AV1)
    # tsdemux's precedence where two rows match one loop: the descriptor before the registration.
    check("1 classify: teletext before BSSD on one loop (tsdemux's order)",
          dc.classify(0x06, h("5605656e670988" "050442535344")).caps == dc.CAPS_TTX)
    none = [("0x06 bare", 0x06, b""), ("0x86 SCTE-35", 0x86, b""), ("0x82 DTS (tp-h264-dts)", 0x82, b""),
            ("0x8A DTS", 0x8A, b""), ("0x06 + DTS1", 0x06, h("050444545331")),
            ("0x06 + AC-4's extension", 0x06, h("7f0215ab")),
            ("0x06 + Opus, no extension", 0x06, h("05044f707573")),
            ("0x15 without a metadata descriptor", 0x15, b""), ("0x05 sections", 0x05, b""),
            ("0x0B DSM-CC", 0x0B, b"")]
    check("1 classify: no row for " + ", ".join(n for n, _, _ in none),
          all(dc.classify(t, loop) is None for _, t, loop in none))
    check("1 classify: section types are no unknown stream (0x05, 0x0B, 0x86)",
          {0x05, 0x0B, 0x86} <= dc.SECTION_TYPES and not {0x06, 0x82, 0x15} & dc.SECTION_TYPES)
    check("1 classify: an unknown stream's class: DTS in any form and AC-4 audio, 0x06 bare private",
          dc.unknown_class(0x82, b"") == "audio" and dc.unknown_class(0x8A, b"") == "audio" and
          dc.unknown_class(0x06, h("050444545331")) == "audio" and
          dc.unknown_class(0x06, h("7f0215ab")) == "audio" and dc.unknown_class(0x06, b"") == "private"
          and dc.unknown_class(0x15, b"") == "private")
    check("1 classify: registration_format is the first 0x05's, 0 when it is short (tsdemux)",
          dc.registration_format(h("0a04656e6700050442535344")) == dc.REG_BSSD and
          dc.registration_format(h("050242530504" "42535344")) == 0 and dc.registration_format(b"") == 0)
    check("1 classify: language: the first 0x0A's last entry, else the 0x59's; under 2 bytes none",
          dc.language(h("0a08656e6700646575000a04667261005908656e671000010152")) == "deu" and
          dc.language(h("5908756e641000010152")) == "und" and dc.language(h("0a0400000000")) == "")
    # Every channel configuration tsdemux reads, its caps as tsdemux 1.28.2 makes them (measured).
    fam255 = ("channels=(int)2, channel-mapping-family=(int)255, stream-count=(int)%d, "
              "coupled-count=(int)%d")
    opus_rows = [
        ("8000", fam255 % (1, 1) + ", channel-mapping=(int)< 0, 1 >"),
        ("8080", fam255 % (2, 0) + ", channel-mapping=(int)< 0, 1 >"),
        ("8001", "channels=(int)1, channel-mapping-family=(int)0, stream-count=(int)1, "
                 "coupled-count=(int)0"),
        ("8003", "channels=(int)3, channel-mapping-family=(int)1, stream-count=(int)2, "
                 "coupled-count=(int)1, channel-mapping=(int)< 0, 2, 1 >"),
        ("8008", "channels=(int)8, channel-mapping-family=(int)1, stream-count=(int)5, "
                 "coupled-count=(int)3, channel-mapping=(int)< 0, 6, 1, 2, 3, 4, 5, 7 >"),
        ("8082", "channels=(int)2, channel-mapping-family=(int)1, stream-count=(int)2, "
                 "coupled-count=(int)0, channel-mapping=(int)< 0, 1 >"),
        ("8088", "channels=(int)8, channel-mapping-family=(int)1, stream-count=(int)8, "
                 "coupled-count=(int)0, channel-mapping=(int)< 0, 1, 2, 3, 4, 5, 6, 7 >"),
        ("80810200", "channels=(int)2, channel-mapping-family=(int)0, stream-count=(int)1, "
                     "coupled-count=(int)1"),
        ("8081020205", "channels=(int)2, channel-mapping-family=(int)2, stream-count=(int)1, "
                       "coupled-count=(int)0, channel-mapping=(int)< 1, 1 >"),
        ("8081040130298000", "channels=(int)4, channel-mapping-family=(int)1, stream-count=(int)2, "
                             "coupled-count=(int)2, channel-mapping=(int)< 0, 1, 2, 3 >"),
    ]
    check("1 classify: Opus caps for the dual-mono, 1-8, 0x82-0x88 and extended configurations",
          all(dc.opus_caps(h(ext)) == "audio/x-opus, rate=(int)48000, " + caps
              for ext, caps in opus_rows))
    check("1 classify: no Opus pad for code 0x89, a short extension or a bit field past its end",
          dc.opus_caps(h("8089")) is None and dc.opus_caps(h("80")) is None and
          dc.opus_caps(h("7f02")) is None and dc.opus_caps(h("8081040161")) is None)


# --- 2 pad names ----------------------------------------------------------------------------------

def test_pad_name():
    check("2 pad_name: (audio, 0, 0x141) is audio_0_0141",
          dc.pad_name("audio", 0, 0x141) == "audio_0_0141")
    check("2 pad_name: (private, 17, 0x1FFF) is private_1_1fff: the generation in 4 bits",
          dc.pad_name("private", 17, 0x1FFF) == "private_1_1fff")
    ev, _ = replay("cap-mux-align7-aac-opus")
    plans = of(ev, "plan")
    check("2 pad_name: the first program is generation 0 (audio_0_0100, audio_0_0108, as tsdemux)",
          len(plans) == 1 and plans[0]["gen"] == 0 and
          [p["pad"] for p in plans[0]["pads"]] == ["audio_0_0100", "audio_0_0108"])
    t = Ts()
    t.pat()
    for k in range(18):
        t.pmt([(PID_V, 0x1B if k % 2 == 0 else 0x24, b"")], PID_V, version=k % 32)
    ev = run(dc.DemuxCore(), t.b, 100 * SEC)
    names = [p["pads"][0]["pad"] for p in of(ev, "plan")]
    check("2 pad_name: 18 programs, generations 0-17, named 0-f then 0, 1 again",
          len(names) == 18 and names[15] == "video_f_0100" and names[16] == "video_0_0100" and
          names[17] == "video_1_0100" and of(ev, "plan")[17]["gen"] == 17)


# --- 3 the 33-bit wrap ----------------------------------------------------------------------------

def test_wrap():
    ev, _ = replay("syn-wrap-33bit")
    by = units_by_pid(ev)
    steady, behind, crossed, bframes, straddle = True, True, 0, 0, 0
    for us in by.values():
        for a, b in zip(us, us[1:]):
            steady &= abs(b["pts"] - a["pts"]) < SEC
            if b.raw[0] < a.raw[0] - (1 << 32):
                crossed += 1
        for u in us:
            if u.raw[1] >= 0:
                bframes += 1
                behind &= 0 <= u["pts"] - u["dts"] < 5 * SEC
                if (u.raw[0] < (1 << 32)) != (u.raw[1] < (1 << 32)):
                    straddle += 1
    check("3 syn-wrap-33bit: every pad's PTS continuous across 2^33 (each PID wraps once)",
          steady and crossed == len(by) == 4)
    check("3 syn-wrap-33bit: a B-frame DTS under 5 s behind its PTS, never 2^33 off, the wrap between "
          "them too", behind and bframes == 84 and straddle == 1)


# --- 4 chunking -----------------------------------------------------------------------------------

def test_chunking():
    out = {}
    for chunk in (188, 1000, 1316, 24576):
        ev, core = replay("cap-mux-align7-aac-opus", chunk=chunk)
        out[chunk] = lines(ev) + [str(core.counters())]
    check("4 cap-mux-align7-aac-opus: 188, 1000, 1316 and 24576-byte feeds give identical events",
          len(out[188]) > 900 and all(out[c] == out[188] for c in out))
    same = []
    for name in fixture_names():
        a, ka = replay(name, chunk=188)
        b, kb = replay(name, chunk=24576)
        same.append(lines(a) == lines(b) and ka.counters() == kb.counters())
    check("4 every fixture: 188 and 24576-byte feeds give identical events (%d fixtures)" % len(same),
          len(same) >= 30 and all(same))


# --- 5 PES without PTS ----------------------------------------------------------------------------

def test_no_pts():
    ev, core = replay("syn-pes-no-pts")
    untimed = [u for u in of(ev, "unit") if u["pts"] is None]
    with open(os.path.join(FIXTURES, "syn-pes-no-pts.expect.jsonl")) as f:
        dumped = sum(1 for line in f if '"pid":257,' in line and '"pts":null' in line)
    check("5 syn-pes-no-pts: units without a PTS leave untimed (PTS, DTS, duration none)",
          len(untimed) == dumped == 16 and all(u["dts"] is None and u["dur"] is None for u in untimed))
    check("5 syn-pes-no-pts: pes-no-pts counts them", core.counters()["pesNoPts"] == len(untimed))


# --- 6 a hole without a marker --------------------------------------------------------------------

def test_gap_500ms():
    ev, _ = replay("syn-gap-500ms")
    gaps = of(ev, "gap")
    audio = of(ev, "gap", "audio_0_0102")
    frame = 1024 * SEC // 48000
    check("6 syn-gap-500ms: one gap of 500 ms +- one frame on the audio pad, a jump",
          len(audio) == 1 and abs(audio[0]["dur"] - 500 * MS) <= frame and audio[0]["reason"] == "jump")
    after = [u for u in of(ev, "unit", "audio_0_0102") if audio and u["pts"] >= audio[0]["pts"]]
    check("6 syn-gap-500ms: the next audio unit at the gap's end, DISCONT",
          bool(after) and after[0]["pts"] == audio[0]["pts"] + audio[0]["dur"] and after[0]["discont"])
    check("6 syn-gap-500ms: none on video (520 ms, under 1 s), none on teletext (sparse, fed every "
          "500 ms)", len(gaps) == 1 and not of(ev, "gap", "video_0_0100") and
          not of(ev, "gap", "private_0_0103"))
    # The other loss: a bus buffer flagged DISCONT (bytes may be missing before it).
    data = fixture("cap-mux-align7-aac-opus")
    now = dc.first_pes_house_ns(data)
    whole, _ = replay("cap-mux-align7-aac-opus")
    cut = 2000 * PKT + 100                        # inside a PES of each PID, not on a packet edge
    d = dc.DemuxCore()
    out = d.feed(data[:cut], False, now)
    before = {u["pad"]: u["pts"] for u in of(out, "unit")}
    out = d.feed(data[cut:], True, now) + d.drain()
    nxt = {}
    for u in of(out, "unit"):
        nxt.setdefault(u["pad"], u)
    lost = [(u["pad"], u["pts"]) for u in of(whole, "unit")
            if before[u["pad"]] < u["pts"] < nxt[u["pad"]]["pts"]]
    rest = [(u["pad"], u["pts"]) for u in of(whole, "unit") if u["pts"] > before[u["pad"]]]
    check("6 a bus DISCONT mid-stream: the PES open at it dropped (AAC's here), nothing else lost, "
          "every pad's next unit DISCONT", len(nxt) == 2 and all(u["discont"] for u in nxt.values())
          and len(lost) == 1 and lost[0][0] == "audio_0_0100" and
          sorted(lost + [(u["pad"], u["pts"]) for u in of(out, "unit")]) == sorted(rest))


# --- 7 a hole with markers ------------------------------------------------------------------------

def _last_before(ev, pad, at):
    return [e for e in ev[:at] if e.kind == "unit" and e["pad"] == pad][-1]


def _horizon_before(ev, pad, at):
    """The end of the pad's last unit before index `at`: its PTS + the upper median of its last 8
    spacings (SelectDemux's frame)."""
    us = [e["pts"] for e in ev[:at] if e.kind == "unit" and e["pad"] == pad][-9:]
    spacings = sorted(b - a for a, b in zip(us, us[1:]))
    return us[-1] + spacings[len(spacings) // 2]


def test_gap_marker():
    bus = sidecar("syn-gap-marker")
    ev, core = replay("syn-gap-marker", bus=bus)
    gaps = of(ev, "gap")
    k = core.counters()
    check("7 syn-gap-marker: one marker gap per marked PID (video, audio), no jump, none on teletext",
          [(g["pad"], g["reason"]) for g in gaps] ==
          [("video_0_0100", "marker"), ("audio_0_0102", "marker")]
          and k["markers"] == 2 and k["markersDropped"] == 0)
    ok = len(gaps) == 2
    for g in gaps:
        i = ev.index(g)
        nxt = next(e for e in ev[i + 1:] if e.kind == "unit" and e["pad"] == g["pad"])
        ok &= g["pts"] == _horizon_before(ev, g["pad"], i) and g["pts"] + g["dur"] == nxt["pts"]
        ok &= nxt["discont"] and not _last_before(ev, g["pad"], i)["discont"]
    check("7 syn-gap-marker: each gap from its pad's last unit's end to the next unit's PTS, DISCONT "
          "next", ok)
    vi = ev.index(gaps[0]) if gaps else 0
    check("7 syn-gap-marker: the video PES open at the marker (unbounded) leaves before its gap",
          bool(gaps) and _last_before(ev, "video_0_0100", vi)["pts"] == gaps[0]["pts"] - 40 * MS)
    # Each marker 100 ms longer than its hole: trimmed to the horizon (B-21), the same gaps.
    data = bytearray(fixture("syn-gap-marker"))
    for b in bus:
        if b["flags"] & 2048:
            for at in range(b["off"], b["off"] + b["len"], PKT):
                n = int.from_bytes(data[at + 7:at + 15], "big") + 100 * MS
                data[at + 7:at + 15] = n.to_bytes(8, "big")
    ev2, _ = replay(bytes(data), bus=bus)
    check("7 syn-gap-marker: markers 100 ms longer than the hole are trimmed to the horizon",
          [(g["pad"], g["pts"], g["dur"]) for g in of(ev2, "gap")] ==
          [(g["pad"], g["pts"], g["dur"]) for g in gaps])
    d = dc.DemuxCore()
    d.feed(fixture("syn-gap-marker")[:200 * PKT], False, 1000 * SEC)
    out = d.marker(build_gap_packet(0x1FF, 0, 300 * MS), 1003 * SEC)
    check("7 syn-gap-marker: a marker on a PID without a pad is ignored",
          out == [] and d.counters()["markers"] == 0)


# --- 8 video holes --------------------------------------------------------------------------------

def test_video_hole():
    ev, _ = replay("syn-video-hole-1s")
    vs = of(ev, "unit", "video_0_0100")
    holes = [b["pts"] - a["pts"] for a, b in zip(vs, vs[1:]) if b["pts"] - a["pts"] > 60 * MS]
    gaps = of(ev, "gap")
    check("8 syn-video-hole-1s: 1, 2 and 5 missing frames (three times each) give no gap",
          len(holes) == 10 and sum(1 for x in holes if x < 300 * MS) == 9)
    check("8 syn-video-hole-1s: the 1.2 s hole gives one jump gap of it, none on audio",
          len(gaps) == 1 and gaps[0]["pad"] == "video_0_0100" and gaps[0]["reason"] == "jump" and
          abs(gaps[0]["dur"] - 1200 * MS) < 10 * MS)


# --- 9 PMT changes --------------------------------------------------------------------------------

def test_pmt_change():
    ev, _ = replay("syn-pmt-version-bump")
    seq = [(e.kind, e.get("version", e.get("gen"))) for e in ev
           if e.kind in ("section", "plan", "gone") and e.get("table") != "pat"]
    check("9 pmt-version-bump: version 1 (the same streams) no plan; version 2 (0x100 to HEVC) plan(1), "
          "gone(0); version 3 (the PCR to 0x101) plan(2), gone(1)",
          seq == [("section", 0), ("plan", 0), ("section", 1), ("section", 2), ("plan", 1), ("gone", 0),
                  ("section", 3), ("plan", 2), ("gone", 1)])
    plans = of(ev, "plan")
    check("9 pmt-version-bump: the new pads by generation, HEVC caps from version 2, the PCR PID",
          [p["pads"][0]["pad"] for p in plans] == ["video_0_0100", "video_1_0100", "video_2_0100"]
          and plans[1]["pads"][0]["caps"] == dc.CAPS_H265 and
          [p["pcrPid"] for p in plans] == [0x100, 0x100, 0x101])
    ok = True
    for p in plans[1:]:
        i = ev.index(p)
        old, new = "_%d_" % (p["gen"] - 1), "_%d_" % p["gen"]
        later = [e for e in ev[i:] if e.kind == "unit"]
        ok &= bool(later) and all(old not in e["pad"] for e in later) and new in later[0]["pad"]
        ok &= later[0]["discont"]
    check("9 pmt-version-bump: the plan before the new program's first unit, no unit on the old pads "
          "after", ok)
    t = Ts()
    t.pat()
    t.pmt([(PID_V, 0x1B, b""), (0x101, 0x0F, h("0a04656e6700"))], PID_V, 0)
    t.pmt([(0x101, 0x0F, h("0a04667261007c0158")), (PID_V, 0x1B, b"")], PID_V, 1)
    ev = run(dc.DemuxCore(), t.b, 100 * SEC)
    check("9 pmt change: the streams reordered and a language changed is the same program (pads kept)",
          len(of(ev, "plan")) == 1 and len(of(ev, "section")) == 3)


# --- 10 the formula -------------------------------------------------------------------------------

def test_formula():
    n, exact, trip, dts_trip, inexact = 0, True, True, True, 0
    for name in fixture_names():
        ev, _ = replay(name)
        for u in of(ev, "unit"):
            if u["pts"] is None:
                continue
            pts33, dts33, pts_u, dts_u = u.raw
            n += 1
            exact &= dc.ns_to_pts90k(u["pts"]) == pts_u - BASE
            trip &= (dc.ns_to_pts90k(u["pts"]) + BASE) % WRAP == pts33
            if dts_u is not None:
                dts_trip &= (dc.ns_to_pts90k(u["dts"]) + BASE) % WRAP == dts33
                dts_trip &= dc.ns_to_pts90k(u["dts"]) == dts_u - BASE
            inexact += (pts_u - BASE) % 9 != 0
    check("10 formula: ns_to_pts90k(PTS) == unwrapped PES - 1 h for every unit of every fixture (%d)"
          % n, n > 10000 and exact)
    check("10 formula: through mpegtsmux's floor every PTS and DTS comes back as its PES's (%d off the "
          "9-tick grid)" % inexact, trip and dts_trip and inexact > 1000)


# --- 11 unknown streams, not house time -----------------------------------------------------------

def test_unknown_not_house():
    ev, core = replay("syn-private-novdesc")
    unk = [(e["pid"], e["type"], e["reg"], e["gen"]) for e in of(ev, "unknown")]
    data = fixture("syn-private-novdesc")
    pmts = sum(1 for at in range(0, len(data), PKT) if dc.ts_pid(data[at:at + PKT]) == 0x1000)
    check("11 syn-private-novdesc: one unknown for 0x06 bare (0x104) and DTS 0x82 (0x106), none for "
          "0x86, across %d PMT packets" % pmts,
          unk == [(0x104, 0x06, "", 0), (0x106, 0x82, "", 0)] and pmts > 3 and
          core.counters()["unknownStreams"] == 2)
    check("11 syn-private-novdesc: no pad for them, never reassembled",
          [p["pid"] for p in of(ev, "plan")[0]["pads"]] == [0x102] and core.selected_pids() == [0x102])
    ev, _ = replay("tp-h264-dts")
    check("11 tp-h264-dts: one unknown for its DTS PID",
          [(e["pid"], e["type"]) for e in of(ev, "unknown")] == [(0x101, 0x82)])
    ev, _ = replay("tp-h264-dts", media=("video",))
    check("11 tp-h264-dts, media=video: no warning for an audio stream it would not expose",
          not of(ev, "unknown") and len(of(ev, "plan")[0]["pads"]) == 1)
    t = Ts()
    t.pat()
    t.pmt([(PID_V, 0x1B, b""), (0x105, 0x8A, b"")], PID_V, 0)
    t.pmt([(PID_V, 0x1B, b""), (0x105, 0x8A, h("0a04656e6700"))], PID_V, 1)
    t.pmt([(PID_V, 0x24, b""), (0x105, 0x8A, b"")], PID_V, 2)
    ev = run(dc.DemuxCore(), t.b, 100 * SEC)
    check("11 unknown: once per PID per generation, not again at a version-only change",
          [(e["pid"], e["gen"]) for e in of(ev, "unknown")] == [(0x105, 0), (0x105, 1)])
    own = dc.first_pes_house_ns(fixture("cap-302m-bssd"))
    ev, _ = replay(_shifted(fixture("cap-302m-bssd"), 2 * 3600 * 90000), house_ns=own)
    check("11 cap-302m-bssd rebased 2 h later (every PES and PCR moved), at its own clock: one "
          "not-house-time, +7200000 ms, the units 2 h on",
          [(e["pid"], e["offsetMs"]) for e in of(ev, "nothouse")] == [(0x41, 7200000)] and
          of(ev, "unit")[0]["pts"] == own + 2 * H)
    ev, _ = replay("cap-302m-bssd", house_ns=own + 2 * H)
    check("11 cap-302m-bssd 2 h behind the clock: one not-house-time, -7200000 ms, the units at their "
          "own time", [(e["pid"], e["offsetMs"]) for e in of(ev, "nothouse")] == [(0x41, -7200000)]
          and of(ev, "unit")[0]["pts"] == own)
    own7 = dc.first_pes_house_ns(fixture("cap-mux-align7-aac-opus"))
    ev, _ = replay("cap-mux-align7-aac-opus", house_ns=own7 - 2 * H)
    first = {}
    for u in of(ev, "unit"):
        first.setdefault(u.pid, u["pts"])
    want = sorted((pid, (pts - own7 + 2 * H) // MS) for pid, pts in first.items())
    check("11 cap-mux-align7 2 h ahead of the clock: once per PID (two pads, two), each its own offset",
          sorted((e["pid"], e["offsetMs"]) for e in of(ev, "nothouse")) == want and len(first) == 2)
    ev, _ = replay("cap-302m-bssd", house_ns=own - 59 * SEC)
    ev2, _ = replay("cap-302m-bssd", house_ns=-1)
    check("11 not-house-time: none at 59 s, none without a clock", not of(ev, "nothouse") and
          not of(ev2, "nothouse") and of(ev2, "unit")[0]["pts"] == own)


def _shifted(data, ticks):
    """`data` with every PES PTS and DTS and every PCR moved by `ticks` (headers whole in their
    packet, as in the 302M capture), mod 2^33."""
    out = bytearray()
    for at in range(0, len(data) - PKT + 1, PKT):
        p = bytearray(data[at:at + PKT])
        v = dc.parse_packet(p)
        if v.af_pcr:
            dc.hr.write_pcr(p, (dc.read_pcr(p) + ticks * 300) % dc.hr.PCR_MODULO)
        if v.pusi and v.payload_off < PKT:
            hd = dc.parse_pes_header(p, v.payload_off, PKT - v.payload_off)
            if hd is not None and hd.complete and hd.pts >= 0:
                dc.hr.rewrite_pes_timestamps(v, hd, (hd.pts + ticks) % WRAP,
                                             (hd.dts + ticks) % WRAP if hd.dts >= 0 else -1)
        out += p
    return bytes(out)


# --- 12 the select configuration (tests/ts_select_test.cpp) ---------------------------------------

def _raises(f):
    try:
        f()
    except ValueError:
        return True
    return False


def _found_on(loop, stype=0x06):
    t = Ts()
    t.pat()
    t.pmt([(PID_A, stype, loop)], PID_A)
    d = sel()
    run(d, t.b, 100 * SEC)
    return d.pid() == PID_A


def test_select():
    check("12 select: audio/x-smpte-302m is the one stream select names; another refused",
          sel().cfg.select == SELECT and _raises(lambda: dc.DemuxCore(dc.Config(select="audio/mpeg"))))
    a, b, c = s302m(1024), s302m(480, 8, 24), s302m(2000, 6, 20)
    check("12 select: s302m_frames: 1024 frames stereo 16-bit (5124 bytes, mpegtsmux's shape)",
          len(a) == 5124 and dc.s302m_frames(a) == 1024)
    check("12 select: s302m_frames: 480 frames of 8 channels at 24 bits; 2000 of 6 at 20",
          dc.s302m_frames(b) == 480 and dc.s302m_frames(c) == 2000)
    reserved = bytearray(a)
    reserved[3] |= 0x30
    check("12 select: s302m_frames: -1 when the size disagrees, on the reserved width, at 4 bytes or "
          "less", dc.s302m_frames(a + b"\0") == -1 and dc.s302m_frames(reserved) == -1 and
          dc.s302m_frames(a[:4]) == -1 and dc.s302m_frames(b"") == -1)
    opus = h("05044f707573")
    check("12 select: the stream is 0x06 whose first registration is BSSD",
          _found_on(BSSD) and _found_on(h("0a04656e6700") + BSSD))
    check("12 select: not 0x06 without BSSD, nor with another first registration, nor another stream "
          "type with BSSD", not _found_on(b"") and not _found_on(opus) and not _found_on(opus + BSSD)
          and not _found_on(BSSD, 0x0F))
    t = Ts()
    t.psi_302m()
    for k in range(6):
        t.frame(1000 + k * TICKS_20MS)
    data = bytes(t.b[:400]) + b"\x00\x47\x12" + bytes(t.b[400:])
    d1, d2 = sel(), sel()
    o1, o2 = run(d1, data, 100 * SEC, 77), run(d2, data, 100 * SEC)
    check("12 select: walk: 77-byte feeds and garbage give one feed's units, 3 bytes resynced",
          lines(o1) == lines(o2) and len(o1) == 6 and d1.counters()["desyncBytes"] == 3)
    for part in (_select_formula, _select_seed, _select_wrap, _select_jump, _select_cc_loss,
                 _select_spacing_across_markers, _select_markers, _select_no_stream,
                 _select_programs_and_pid_change, _select_discont_drain_flush, _select_no_pts):
        part()


def _select_formula():
    t0 = 9000000                                  # 100 s in ticks, a multiple of 9
    t = Ts()
    t.psi_302m()
    for k in range(50):
        t.frame(t0 + k * TICKS_20MS)
    d = sel()
    out = run(d, t.b, 100 * SEC - 40 * MS)
    us = of(out, "unit")
    check("12 select: formula: one unit per PES, PTS = ceil(PES - 1 h) exactly",
          len(us) == 50 and all(u["pts"] == ceil_ns(t0 + k * TICKS_20MS) for k, u in enumerate(us)))
    check("12 select: formula: DTS = PTS (302M has none); duration from the AES3 header; the payload",
          all(u["dts"] == u["pts"] and u["dur"] == 20 * MS and u.payload == s302m(960) for u in us))
    check("12 select: formula: DISCONT on the pad's first unit only, the pad named src",
          all(u["discont"] == (k == 0) and u["pad"] == "src" for k, u in enumerate(us)))
    check("12 select: formula: units alone (no plan, section or found event)", len(out) == 50)
    c = d.counters()
    check("12 select: formula: state found, PID, program, frame 20 ms; counters",
          d.state() == d.FOUND and d.pid() == PID_A and d.program() == 1 and d.frame_ns() == 20 * MS
          and c["pes"] == 50 and c["gaps"] == 0 and c["ccLost"] == 0 and c["pesDroppedCc"] == 0 and
          c["desyncBytes"] == 0)
    same = all(lines(run(sel(), t.b, 100 * SEC - 40 * MS, chunk)) == lines(out)
               for chunk in (188, 1316, 7, 1000, 24576))
    check("12 select: chunking: 188, 1316, 7, 1000 and 24576-byte feeds give the same units", same)


def _select_seed():
    house = 30 * H
    t0 = dc.ns_to_pts90k(house)
    t = Ts()
    t.psi_302m()
    for k in range(3):
        t.frame(t0 + k * TICKS_20MS)
    us = of(run(sel(), t.b, house + 5 * MS), "unit")
    check("12 select: B-14: at 30 h the PES are 33-bit folded and come out at 30 h, not 26.5 h behind",
          len(us) == 3 and t0 + BASE > WRAP and us[0]["pts"] == ceil_ns(t0) and
          us[2]["pts"] == ceil_ns(t0 + 3600))
    late = of(run(sel(), t.b, house + 12 * H), "unit")
    early = of(run(sel(), t.b, house - 12 * H), "unit")
    check("12 select: seed: content 12 h before or after the clock still unwraps to it",
          len(late) == len(early) == 3 and late[0]["pts"] == early[0]["pts"] == ceil_ns(t0))
    u = Ts()
    u.psi_302m()
    u.frame(450000)
    none = of(run(sel(), u.b, -1), "unit")
    check("12 select: no clock: the PES seeds itself, 1 h + 5 s gives 5 s",
          len(none) == 1 and none[0]["pts"] == 5 * SEC)


def _select_wrap():
    wrap_t = WRAP - BASE                          # the house tick where the PES field wraps
    t0 = wrap_t - 50 * TICKS_20MS
    t = Ts()
    t.psi_302m()
    for k in range(100):
        t.frame(t0 + k * TICKS_20MS)
    d = sel()
    us = of(run(d, t.b, dc.pts90k_to_ns(t0) + 10 * MS, 1316), "unit")
    even = len(us) == 100 and all(b["pts"] - a["pts"] == 20 * MS for a, b in zip(us, us[1:]))
    crossed = len(us) == 100 and us[49]["pts"] < ceil_ns(wrap_t) and \
        us[50]["pts"] == ceil_ns(wrap_t) and us[99]["pts"] == ceil_ns(t0 + 99 * TICKS_20MS)
    check("12 select: wrap: 100 PES across 2^33, every step 20 ms, the PTS continuous through it",
          even and crossed)
    check("12 select: wrap: no gap", d.counters()["gaps"] == 0)


def _select_jump():
    t0 = 9000000
    t = Ts()
    t.psi_302m()
    for k in range(10):
        t.frame(t0 + k * TICKS_20MS)
    hole_at = t0 + 10 * TICKS_20MS                # where the 11th frame would be
    t.frame(hole_at + 45000)                      # 500 ms of nothing, CC unbroken
    t.frame(hole_at + 45000 + TICKS_20MS)
    d = sel()
    out = run(d, t.b, 100 * SEC)
    gaps, us = of(out, "gap"), of(out, "unit")
    check("12 select: jump: a 500 ms hole gives one GAP of exactly 500 ms from the last frame's end",
          len(gaps) == 1 and gaps[0]["pts"] == ceil_ns(hole_at) and gaps[0]["dur"] == 500 * MS and
          gaps[0]["reason"] == "jump")
    i = out.index(gaps[0]) if gaps else -2
    check("12 select: jump: the GAP comes right before the unit after the hole, which is DISCONT",
          i >= 0 and out[i + 1].kind == "unit" and out[i + 1]["discont"] and
          out[i + 1]["pts"] == ceil_ns(hole_at + 45000))
    check("12 select: jump: 12 units, gaps 1, the next unit not DISCONT",
          len(us) == 12 and not us[11]["discont"] and d.counters()["gaps"] == 1)
    for extra in (0, 1):
        u = Ts()
        u.psi_302m()
        for k in range(5):
            u.frame(t0 + k * TICKS_20MS)
        u.frame(t0 + 5 * TICKS_20MS + 2 * TICKS_20MS + extra)
        g = of(run(sel(), u.b, 100 * SEC), "gap")
        if extra == 0:
            check("12 select: jump: a hole of exactly two frames is no gap", not g)
        else:
            check("12 select: jump: two frames and a tick is a gap", len(g) == 1)
    v = Ts()
    v.psi_302m()
    v.frame(t0)
    v.frame(t0 + TICKS_20MS + 45000)
    f = sel()
    check("12 select: jump: no test before two spacings are known",
          not of(run(f, v.b, 100 * SEC), "gap") and f.frame_ns() == -1)
    w = Ts()
    w.psi_302m()
    at = t0
    for _ in range(6):
        w.frame(at, 512)                          # 512 frames = 960 ticks
        at += 960
    for _ in range(6):
        w.frame(at, 2048)                         # 2048 frames = 3840 ticks
        at += 3840
    wo = run(sel(), w.b, 100 * SEC)
    check("12 select: jump: a cadence rise 512 -> 2048 frames gives no gap",
          not of(wo, "gap") and len(of(wo, "unit")) == 12)
    j = Ts()
    j.psi_302m()
    at = t0
    junk = bytes([0x5A]) * 300
    for _ in range(9):
        j.pes(PID_A, (at + BASE) % WRAP, junk)
        at += TICKS_20MS
    for _ in range(12):
        j.pes(PID_A, (at + BASE) % WRAP, junk)
        at += 4 * TICKS_20MS
    jd = sel()
    jo = run(jd, j.b, 100 * SEC)
    check("12 select: jump: no duration, a lasting 20 -> 80 ms rise: 4 gaps, then the rise is learned",
          len(of(jo, "gap")) == 4 and jd.frame_ns() == 80 * MS and len(of(jo, "unit")) == 21)
    m2 = Ts()
    m2.psi_302m()
    m2.frame(t0)
    m2.frame(t0 + TICKS_20MS)
    m2.frame(t0 + TICKS_20MS + 2700)
    md = sel()
    run(md, m2.b, 100 * SEC)
    check("12 select: frame: the upper median of the spacings (20 and 30 ms: 30)",
          md.frame_ns() == 30 * MS)
    x = Ts()
    x.psi_302m()
    for k in range(5):
        x.frame(t0 + k * TICKS_20MS)
    x.frame(t0)
    xo = run(sel(), x.b, 100 * SEC)
    check("12 select: jump: a backward step is no gap and is emitted at its own PTS",
          not of(xo, "gap") and len(of(xo, "unit")) == 6 and of(xo, "unit")[5]["pts"] == ceil_ns(t0))


def _select_cc_loss():
    t0 = 9000000
    t = Ts()
    t.psi_302m()
    for k in range(4):
        t.frame(t0 + k * TICKS_20MS)
    cut = len(t.b) + 3 * PKT                      # a packet inside the 5th PES
    for k in range(4, 8):
        t.frame(t0 + k * TICKS_20MS)
    d = sel()
    us = of(run(d, bytes(t.b[:cut]) + bytes(t.b[cut + PKT:]), 100 * SEC), "unit")
    check("12 select: cc loss: the PES it cut is dropped, the next unit DISCONT",
          len(us) == 7 and us[4]["pts"] == ceil_ns(t0 + 5 * TICKS_20MS) and us[4]["discont"] and
          not us[3]["discont"] and not us[5]["discont"])
    c = d.counters()
    check("12 select: cc loss: cc-lost 1, pes-dropped-cc 1, and no gap for one missing frame",
          c["ccLost"] == 1 and c["pesDroppedCc"] == 1 and c["gaps"] == 0)
    u = Ts()
    u.psi_302m()
    for k in range(4):
        u.frame(t0 + k * TICKS_20MS)
    a = len(u.b)
    for k in range(4, 7):
        u.frame(t0 + k * TICKS_20MS)
    b = len(u.b)
    for k in range(7, 10):
        u.frame(t0 + k * TICKS_20MS)
    e = sel()
    o2 = run(e, bytes(u.b[:a]) + bytes(u.b[b:]), 100 * SEC)
    g2 = of(o2, "gap")
    check("12 select: cc loss: three frames lost give a GAP of 60 ms and a DISCONT unit",
          len(g2) == 1 and g2[0]["dur"] == 60 * MS and e.counters()["ccLost"] == 1 and
          of(o2, "unit")[4]["discont"])
    # A spacing across a loss is no frame: three 40 ms ones leave the frame at 20 ms.
    w = Ts()
    w.psi_302m()
    at = t0
    for _ in range(3):
        w.frame(at)
        at += TICKS_20MS
    lossy = bytes(w.b)
    for _ in range(3):
        w.b = bytearray()
        w.frame(at)                               # lost whole: the CC jump shows at the next
        at += TICKS_20MS
        w.b = bytearray()
        w.frame(at)
        lossy += bytes(w.b)
        at += TICKS_20MS
    w.b = bytearray()
    w.frame(at + 4500)
    lossy += bytes(w.b)
    f = sel()
    g3 = of(run(f, lossy, 100 * SEC), "gap")
    check("12 select: spacing: none across a CC loss is learned; a 50 ms hole after three is a gap",
          f.counters()["ccLost"] == 3 and f.frame_ns() == 20 * MS and len(g3) == 1 and
          g3[0]["dur"] == 50 * MS)


def _select_spacing_across_markers():
    t0 = 9000000
    x = Ts()
    x.psi_302m()
    at = t0
    for _ in range(3):
        x.frame(at)
        at += TICKS_20MS
    d = sel()
    out = run(d, x.b, 100 * SEC)
    for _ in range(3):
        m = build_gap_packet(PID_A, x.last_cc(PID_A), 20 * MS)
        out += d.marker(m, dc.pts90k_to_ns(at) + 20 * MS)
        at += TICKS_20MS
        x.b = bytearray()
        x.frame(at)
        out += run(d, x.b, 100 * SEC)
        at += TICKS_20MS
    x.b = bytearray()
    x.frame(at + 4500)
    g = of(run(d, x.b, 100 * SEC), "gap")
    check("12 select: spacing: none across a marker is learned; a 50 ms hole after three is a gap",
          len(of(out, "gap")) == 3 and d.frame_ns() == 20 * MS and len(g) == 1 and
          g[0]["dur"] == 50 * MS and g[0]["reason"] == "jump")


def _select_markers():
    t0 = 9000000
    t_end = ceil_ns(t0 + 5 * TICKS_20MS)          # the 5th frame's end
    t = Ts()
    t.psi_302m()
    for k in range(5):
        t.frame(t0 + k * TICKS_20MS)
    cc = t.last_cc(PID_A)
    d = sel()
    run(d, t.b, 100 * SEC)
    out = d.marker(build_gap_packet(PID_A, cc, 300 * MS), t_end + 400 * MS)
    check("12 select: marker: [end - length, end) when it starts past the last PES",
          len(out) == 1 and out[0].kind == "gap" and out[0]["pts"] == t_end + 100 * MS and
          out[0]["dur"] == 300 * MS and out[0]["reason"] == "marker")
    n = Ts()
    n.cc = dict(t.cc)
    n.frame(dc.ns_to_pts90k(t_end + 400 * MS))
    out = run(d, n.b, 100 * SEC)
    check("12 select: marker: the unit after it is DISCONT, no jump GAP for the same hole",
          len(out) == 1 and out[0].kind == "unit" and out[0]["discont"])
    c = d.counters()
    check("12 select: marker: counted (markers 1, dropped 0, gaps 1)",
          c["markers"] == 1 and c["markersDropped"] == 0 and c["gaps"] == 1)
    d = sel()
    run(d, t.b, 100 * SEC)
    out = d.marker(build_gap_packet(PID_A, cc, 50 * MS), t_end + 30 * MS)
    check("12 select: marker: one overlapping the last PES starts at its end",
          len(out) == 1 and out[0]["pts"] == t_end and out[0]["dur"] == 30 * MS)
    d = sel()
    run(d, t.b, 100 * SEC)
    m = build_gap_packet(PID_A, cc, 15 * MS)
    out = d.marker(m, t_end - 2 * MS) + d.marker(m, t_end)
    c = d.counters()
    check("12 select: marker: ones ending inside or at the last PES's end are dropped",
          out == [] and c["markers"] == 2 and c["markersDropped"] == 2 and c["gaps"] == 0)
    v = Ts()
    v.pat()
    v.pmt([(PID_V, 0x1B, b""), (PID_A, 0x06, BSSD)], PID_V)
    for k in range(5):
        v.frame(t0 + k * TICKS_20MS)
    d = sel()
    run(d, v.b, 100 * SEC)
    buf = build_gap_packet(PID_V, 3, 500 * MS) + build_gap_packet(0x1FF, 3, 500 * MS)
    out = d.marker(buf, t_end + 600 * MS)
    check("12 select: marker: ones for other PIDs, the PCR PID's included, are ignored",
          out == [] and d.counters()["markers"] == 0)
    mine = build_gap_packet(PID_A, 0, 100 * MS)
    out = d.marker(mine, -1)
    check("12 select: marker: one with no placeable PTS is counted and dropped",
          out == [] and d.counters()["markers"] == 1 and d.counters()["markersDropped"] == 1)
    out = d.marker(buf + mine, t_end + 600 * MS)
    check("12 select: marker: in a buffer of several PIDs only the selected one's packet counts",
          len(out) == 1 and out[0]["pts"] == t_end + 500 * MS and out[0]["dur"] == 100 * MS and
          d.counters()["markers"] == 2)
    d = sel()
    run(d, t.b, 100 * SEC)
    out = []
    for i in range(4):
        end = t_end + 1000 * MS + i * 250 * MS
        out += d.marker(build_gap_packet(PID_A, cc, end - t_end), end)
    tiled = len(out) == 4 and out[0]["pts"] == t_end and out[0]["dur"] == 1000 * MS and all(
        out[i]["pts"] == out[i - 1]["pts"] + out[i - 1]["dur"] and out[i]["dur"] == 250 * MS
        for i in range(1, 4))
    check("12 select: marker: an outage's repeated markers tile the timeline, never overlapping", tiled)
    p = Ts()
    p.psi_302m()
    d = sel()
    run(d, p.b, 100 * SEC)
    m = build_gap_packet(PID_A, 0, 250 * MS)
    out = d.marker(m, 100 * SEC)
    check("12 select: marker: before the stream's first PES, the gap as given",
          len(out) == 1 and out[0]["pts"] == 100 * SEC - 250 * MS and out[0]["dur"] == 250 * MS)
    e = sel()
    check("12 select: marker: with no stream selected, ignored",
          e.marker(m, 100 * SEC) == [] and e.counters()["markers"] == 0)


def _select_no_stream():
    t = Ts()
    t.pat()
    t.pmt([(PID_V, 0x1B, b""), (PID_B, 0x0F, b"")], PID_V)
    pmt = bytes(t.b)
    d = sel()
    out = d.feed(pmt, False, 50 * SEC)
    check("12 select: no stream: a PMT without 302M is `missing`, no warning yet",
          d.state() == d.MISSING and out == [] and d.pid() == -1)
    for now in range(50 * SEC + 100 * MS, 52 * SEC, 100 * MS):
        out += d.feed(pmt, False, now)
    check("12 select: no stream: none within 2 s of the first PMT", out == [])
    out = d.feed(pmt, False, 52 * SEC)
    check("12 select: no stream: one `nostream` at 2 s", len(out) == 1 and out[0].kind == "nostream")
    out = []
    for now in range(52 * SEC, 60 * SEC, 500 * MS):
        out += d.feed(pmt, False, now)
    check("12 select: no stream: only one per episode", out == [])
    u = Ts()
    u.cc = dict(t.cc)
    u.pmt([(PID_V, 0x1B, b""), (PID_A, 0x06, BSSD)], PID_V, 1)
    out = d.feed(bytes(u.b), False, 60 * SEC)
    check("12 select: no stream: a later PMT with the stream finds it",
          out == [] and d.state() == d.FOUND and d.pid() == PID_A)
    w = Ts()
    w.cc = dict(u.cc)
    w.pmt([(PID_V, 0x1B, b"")], PID_V, 2)
    out = d.feed(bytes(w.b), False, 61 * SEC) + d.feed(bytes(w.b), False, 62 * SEC)
    check("12 select: no stream: the stream gone again is missing, no warning before 2 s",
          out == [] and d.state() == d.MISSING and d.pid() == -1)
    out = d.feed(bytes(w.b), False, 63 * SEC)
    check("12 select: no stream: the new episode warns once at 2 s",
          len(out) == 1 and out[0].kind == "nostream")
    e = sel()
    p = Ts()
    p.pat()
    out = []
    for s in range(10):
        out += e.feed(bytes(p.b), False, s * SEC)
    check("12 select: no stream: no PMT is `waiting`, with no warning",
          out == [] and e.state() == e.WAITING)


def _select_programs_and_pid_change():
    t0 = 9000000
    t = Ts()
    t.pat([(1, 0x100), (2, 0x200)])
    t.pmt([(PID_B, 0x0F, b"")], PID_B, 0, 0x100, 1)
    t.pmt([(PID_A, 0x06, BSSD)], PID_A, 0, 0x200, 2)
    for k in range(3):
        t.frame(t0 + k * TICKS_20MS)
    first, second = sel(), sel(2)
    run(first, t.b, 100 * SEC)
    us = of(run(second, t.b, 100 * SEC), "unit")
    check("12 select: program-number -1 follows the PAT's first program (no 302M there)",
          first.state() == first.MISSING and first.program() == 1)
    check("12 select: program-number 2 follows the second, whose 302M comes out",
          second.state() == second.FOUND and second.program() == 2 and second.pid() == PID_A and
          len(us) == 3)
    u = Ts()
    u.psi_302m(PID_A, 0)
    for k in range(3):
        u.frame(t0 + k * TICKS_20MS, 960, PID_A)
    u.pmt([(PID_B, 0x06, BSSD)], PID_B, 1)
    for k in range(3, 6):
        u.frame(t0 + k * TICKS_20MS, 960, PID_B)
    d = sel()
    us = of(run(d, u.b, 100 * SEC), "unit")
    check("12 select: pid change: on 0x41, then on 0x42; six units, the 4th DISCONT",
          len(us) == 6 and us[3]["discont"] and us[3].pid == PID_B and not us[4]["discont"] and
          d.pid() == PID_B)
    t20 = t0 + 20 * 3600 * 90000                  # the new stream's content 20 h after the old's
    v = Ts()
    v.psi_302m(PID_A, 0)
    v.frame(t0, 960, PID_A)
    e = sel()
    run(e, v.b, 100 * SEC)
    v.b = bytearray()
    v.pmt([(PID_B, 0x06, BSSD)], PID_B, 1)
    v.frame(t20, 960, PID_B)
    far = of(run(e, v.b, dc.pts90k_to_ns(t20)), "unit")
    check("12 select: pid change: the new PID seeds on the clock, not on the old stream's last PTS",
          len(far) == 1 and far[0]["pts"] == ceil_ns(t20))


def _select_discont_drain_flush():
    t0 = 9000000
    t = Ts()
    t.psi_302m()
    third = 0
    for k in range(4):
        if k == 2:
            third = len(t.b) + 5 * PKT
        t.frame(t0 + k * TICKS_20MS)
    d = sel()
    data = bytes(t.b)
    out = d.feed(data[:third], False, 100 * SEC) + d.feed(data[third:], True, 100 * SEC)
    us = of(out, "unit")
    check("12 select: bus discont: the open PES is dropped and the next unit is DISCONT",
          len(us) == 3 and us[2]["pts"] == ceil_ns(t0 + 3 * TICKS_20MS) and us[2]["discont"])
    u = Ts()
    u.psi_302m()
    u.pes(PID_A, (t0 + BASE) % WRAP, s302m(960), False)
    e = sel()
    held = not of(run(e, u.b, 100 * SEC), "unit")
    out = e.drain()
    check("12 select: drain: an unbounded PES is held, then out at EOS",
          held and len(out) == 1 and out[0].kind == "unit" and out[0]["pts"] == ceil_ns(t0) and
          out[0].payload == s302m(960))
    f = sel()
    run(f, t.b, 100 * SEC)
    f.flush()
    again = Ts()                                  # as after a seek: the CC starts afresh
    again.frame(t0)
    o2 = run(f, again.b, 100 * SEC)
    check("12 select: flush: the next unit is DISCONT at its own PTS; a fresh CC is no loss",
          len(o2) == 1 and o2[0]["discont"] and o2[0]["pts"] == ceil_ns(t0) and
          f.counters()["ccLost"] == 0)
    f.flush()
    o3 = f.marker(build_gap_packet(PID_A, 0, 40 * MS), ceil_ns(t0) + 20 * MS)
    check("12 select: flush: a marker after it is not trimmed by the old horizon",
          len(o3) == 1 and o3[0]["pts"] == ceil_ns(t0) - 20 * MS and o3[0]["dur"] == 40 * MS)


def _select_no_pts():
    t = Ts()
    t.psi_302m()
    t.frame(9000000)
    t.frame(9000000 + TICKS_20MS)
    t.pes(PID_A, -1, s302m(960))
    t.frame(9000000 + 3 * TICKS_20MS)
    d = sel()
    us = of(run(d, t.b, 100 * SEC), "unit")
    check("12 select: no PTS: out untimed, counted as pes-no-pts",
          len(us) == 4 and us[2]["pts"] is None and us[2]["dts"] is None and
          d.counters()["pesNoPts"] == 1 and us[3]["pts"] == ceil_ns(9000000 + 3 * TICKS_20MS))
    check("12 select: no PTS: the spacing across it is not learned (one spacing: no frame yet)",
          d.frame_ns() == -1)


# --- 13 media -------------------------------------------------------------------------------------

def test_media():
    ev, core = replay("cap-occ-1080i-h264-aac-ttx", media=("video",))
    plans = of(ev, "plan")
    check("13 cap-occ-1080i-h264-aac-ttx, media=video: one pad, video_0_0065",
          len(plans) == 1 and [p["pad"] for p in plans[0]["pads"]] == ["video_0_0065"])
    check("13 media=video: units on it alone, the audio and teletext PIDs never reassembled",
          {u["pad"] for u in of(ev, "unit")} == {"video_0_0065"} and core.selected_pids() == [0x65]
          and not of(ev, "unknown"))
    t = Ts()
    t.pat()
    t.pmt([(PID_V, 0x1B, b"")], PID_V, 0)
    pmt = bytes(t.b)
    d = dc.DemuxCore(dc.Config(media=("audio",)))
    out = []
    for now in range(50 * SEC, 53 * SEC, 250 * MS):
        out += [(now, e.kind) for e in d.feed(pmt, False, now)]
    u = Ts()
    u.cc = dict(t.cc)
    u.pmt([(PID_V, 0x1B, b""), (0x101, 0x0F, b"")], PID_V, 1)
    later = d.feed(bytes(u.b), False, 53 * SEC)
    check("13 media=audio on a video-only program: a plan without a pad, no-stream once at 2 s, then "
          "found with the audio stream (E16)",
          out == [(50 * SEC, "section"), (50 * SEC, "section"), (50 * SEC, "plan"),
                  (52 * SEC, "nostream")]
          and [e.kind for e in later] == ["section", "plan", "gone"] and d.state() == d.FOUND and
          d.pads() == ["audio_1_0101"])
    ev, _ = replay("cap-occ-1080i-h264-aac-ttx")
    video = of(ev, "unit", "video_0_0065")
    check("13 cap-occ-1080i-h264-aac-ttx (S27: B-frames, teletext): DTS behind PTS on video, the "
          "teletext pad sparse with its units", any(u["dts"] < u["pts"] for u in video) and
          of(ev, "plan")[0]["pads"][9]["pad"] == "private_0_0020" and
          of(ev, "plan")[0]["pads"][9]["sparse"] and len(of(ev, "unit", "private_0_0020")) == 14)
    ev, _ = replay("cap-occ-1080i-h264-21aac-ttx")
    pads = of(ev, "plan")[0]["pads"]
    fed = {u["pad"] for u in of(ev, "unit")}
    check("13 cap-occ-1080i-h264-21aac-ttx (S27: many pads), media default: 23 pads (video, 21 AAC, "
          "teletext), units on every one", len(pads) == 23 and
          sum(1 for p in pads if p["pad"].startswith("audio_0_")) == 21 and
          fed == {p["pad"] for p in pads})


# --- 14 program time on a sparse PCR --------------------------------------------------------------

def _with_idle_teletext(data, pid=0x120):
    """The recording with a teletext stream on `pid` in each PMT, no packet of it sent."""
    out = bytearray(data)
    for at in range(0, len(out), PKT):
        p = bytes(out[at:at + PKT])
        if dc.ts_pid(p) == 0x1000 and p[1] & 0x40:
            pmt = dc.hr.parse_pmt([p], 0x1000)
            streams = list(pmt.streams) + [(pid, 0x06, h("5605656e670988"))]
            out[at:at + PKT] = ts_psi.build_pmt(0x1000, pmt.program_number, pmt.pcr_pid, streams,
                                                p[3] & 0x0F, pmt.version)
    return bytes(out)


def test_sparse_pcr():
    data = fixture("cap-vmix-h264-aac")
    pcrs = sum(1 for at in range(0, len(data), PKT) if dc.read_pcr(data[at:at + PKT]) >= 0)
    core = dc.DemuxCore()
    now = dc.first_pes_house_ns(data)
    follows, n = True, 0
    for at in range(0, len(data), 1316):
        for e in core.feed(data[at:at + 1316], False, now):
            if e.kind == "unit" and e["pts"] is not None:
                n += 1
                follows &= core.program_time_ns() >= e["pts"]
    check("14 cap-vmix-h264-aac (%d PCRs, 2 s apart): program time at or past every unit's PTS (%d)"
          % (pcrs, n), pcrs == 2 and n > 150 and follows)
    ev, _ = replay(_with_idle_teletext(data))
    gaps = of(ev, "gap", "private_0_0120")
    start = min(u["pts"] for u in of(ev, "unit"))
    contiguous = all(b["pts"] == a["pts"] + a["dur"] for a, b in zip(gaps, gaps[1:]))
    check("14 cap-vmix + an idle teletext PID (2 s): two sparse gaps of half a second from its start, "
          "contiguous: they follow the newest PTS, not the PCR (a GAP of 1.5 s at the second)",
          len(gaps) == 2 and contiguous and gaps[0]["pts"] == start and
          all(g["reason"] == "sparse" and 500 * MS < g["dur"] < 600 * MS for g in gaps))
    ev, core = replay("tp-h264-dvbsub")
    pad = "subpicture_0_0102"
    later = []
    for i, g in enumerate(ev):
        if g.kind == "gap" and g["pad"] == pad:
            u = next((u for u in ev[i:] if u.kind == "unit" and u["pad"] == pad), None)
            if u is not None and all(u is not x for x in later):
                later.append(u)
    check("14 tp-h264-dvbsub: a sparse gap marks no loss: the pad's next unit not DISCONT, not "
          "counted", len(of(ev, "gap", pad)) == 9 and len(later) == 2 and
          not any(u["discont"] for u in later) and core.counters()["gaps"] == 0)


# --- 15 AU post-processing ------------------------------------------------------------------------

def test_au_post():
    ev, _ = replay("syn-adts-mpeg2")
    occ, _ = replay("cap-occ-1080i-h264-aac-ttx")
    vmix, _ = replay("cap-vmix-h264-aac")
    check("15 adts_mpegversion: syn-adts-mpeg2's AAC (the ID bit) is 2, as tsdemux refines it",
          {dc.adts_mpegversion(u.payload) for u in of(ev, "unit")} == {2})
    check("15 adts_mpegversion: OCC's AAC is MPEG-2 too, the vMix's MPEG-4; no header or a short one 4",
          {dc.adts_mpegversion(u.payload) for u in of(occ, "unit", "audio_0_00c9")} == {2} and
          {dc.adts_mpegversion(u.payload) for u in of(vmix, "unit", "audio_0_0100")} == {4} and
          dc.adts_mpegversion(b"\x00" * 40) == 4 and dc.adts_mpegversion(h("fff9")) == 4)
    ev, _ = replay("cap-mux-align7-aac-opus")
    us = of(ev, "unit", "audio_0_0108")
    aus = [dc.opus_access_units(u.payload) for u in us]
    check("15 opus_access_units: cap-mux-align7: mpegtsmux's control header stripped, one packet a PES",
          len(us) == 501 and all(a is not None and len(a) == 1 for a in aus) and
          all(len(a[0][0]) < len(u.payload) and u.payload.endswith(a[0][0]) for a, u in zip(aus, us)))
    ev, _ = replay("tp-opus-51")
    aus = [dc.opus_access_units(u.payload) for u in of(ev, "unit", "audio_0_0101")]
    trims = [(i, s, e) for i, a in enumerate(aus) for _, s, e in a if s or e]
    check("15 opus_access_units: tp-opus-51 (ffmpeg): one to three packets a PES, the pre-skip and "
          "the end trimmed", all(a and len(a) in (1, 2, 3) for a in aus) and
          trims == [(0, 312, 0), (199, 0, 648)])
    check("15 opus_access_units: a payload without a control header is one raw packet; a cut one fails",
          dc.opus_access_units(h("fc0102")) == [(h("fc0102"), 0, 0)] and
          dc.opus_access_units(h("7fe0")) is None and dc.opus_access_units(h("7fe005fcff")) is None
          and dc.opus_access_units(b"\x01") is None)
    au = h("000180" "0005") + b"KLV01" + h("010200" "0003") + b"ABC"
    check("15 klv_metadata_cells: a 0x15 AU of two cells split, service, sequence, flags kept",
          dc.klv_metadata_cells(au) == [(0, 1, 0x80, b"KLV01"), (1, 2, 0, b"ABC")])
    check("15 klv_metadata_cells: a cell longer than the AU cut to it; a header short of 5 bytes fails",
          dc.klv_metadata_cells(h("0001000009") + b"ABC") == [(0, 1, 0, b"ABC")] and
          dc.klv_metadata_cells(au + h("0001")) is None)


# --- 16 the expectations --------------------------------------------------------------------------

def test_expectations():
    """Each <name>.demux.jsonl (and .p<N>.demux.jsonl, program N) is the CLI's output at its
    defaults, through the fixture's sidecar where it has one; every fixture has one."""
    files = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".demux.jsonl"))
    names = fixture_names()
    for f in files:
        stem, program = f[:-len(".demux.jsonl")], -1
        if ".p" in stem and stem.rsplit(".p", 1)[1].isdigit():
            stem, program = stem.rsplit(".p", 1)[0], int(stem.rsplit(".p", 1)[1])
        with open(os.path.join(FIXTURES, f)) as fh:
            want = fh.read().splitlines()
        bus = sidecar(stem) if os.path.exists(os.path.join(FIXTURES, stem + ".bus.jsonl")) else None
        got = dc.demux_lines(fixture(stem), dc.Config(program=program), bus=bus) if stem in names else []
        diff = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
        where = "" if got == want else ", first difference at line %d" % (diff + 1)
        check("16 %s: the reference's output (%d lines)%s" % (f, len(want), where), got == want)
    check("16 every fixture has its .demux.jsonl", all(n + ".demux.jsonl" in files for n in names))


def main():
    for test in (test_classify, test_pad_name, test_wrap, test_chunking, test_no_pts, test_gap_500ms,
                 test_gap_marker, test_video_hole, test_pmt_change, test_formula,
                 test_unknown_not_house, test_select, test_media, test_sparse_pcr, test_au_post,
                 test_expectations):
        test()
    if _failures:
        print(f"\n{_failures} FAILURE(S) in demux_core")
        return 1
    print("\nALL demux_core TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
