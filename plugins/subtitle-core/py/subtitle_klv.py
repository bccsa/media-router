"""Python twin of `engine/subtitleCue.ts` — the KLV-wrapped WebVTT cue carrier.

Imported by the gst pipeline runner's subtitle bridge (every `plugins/*/py`
dir is on its PYTHONPATH). Pure stdlib, no GStreamer. Must stay byte-identical
to the TypeScript encoder: both test suites pin the same vectors.

Wire layout of the KLV value (UTF-8):

    HH:MM:SS.mmm --> HH:MM:SS.mmm\\n
    <text line>\\n [...]

Times are house-clock media time in ms (ADR-0005). Empty text = CLEAR cue.
"""

KEY = bytes.fromhex("060e2b34020501010e0e4d5253554231")
MAX_VALUE_BYTES = 4096
PID_BASE = 0x180


def stream_pid(index):
    return PID_BASE + index


def format_vtt_time(ms):
    total = max(0, int(round(ms)))
    h, rem = divmod(total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, f = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{f:03d}"


def parse_vtt_time(text):
    """`HH:MM:SS.mmm` → ms, or None. Hours may have any number of digits >= 2."""
    t = text.strip()
    parts = t.split(":")
    if len(parts) != 3:
        return None
    hh, mm, rest = parts
    if len(hh) < 2 or not hh.isdigit() or len(mm) != 2 or not mm.isdigit():
        return None
    if len(rest) != 6 or rest[2] != "." or not (rest[:2] + rest[3:]).isdigit():
        return None
    m, s = int(mm), int(rest[:2])
    if m > 59 or s > 59:
        return None
    return int(hh) * 3_600_000 + m * 60_000 + s * 1000 + int(rest[3:])


def format_cue_block(start_ms, end_ms, text):
    timing = f"{format_vtt_time(start_ms)} --> {format_vtt_time(max(start_ms, end_ms))}\n"
    body = text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
    return timing + body + "\n" if body else timing


def parse_cue_block(block):
    """→ (start_ms, end_ms, text) or None."""
    nl = block.find("\n")
    timing = block if nl < 0 else block[:nl]
    arrow = timing.find("-->")
    if arrow < 0:
        return None
    start = parse_vtt_time(timing[:arrow])
    end = parse_vtt_time(timing[arrow + 3:])
    if start is None or end is None or end < start:
        return None
    text = "" if nl < 0 else block[nl + 1:].rstrip("\n")
    return start, end, text


def _ber_length(n):
    if n < 0x80:
        return bytes([n])
    out = []
    while n > 0:
        out.insert(0, n & 0xFF)
        n >>= 8
    return bytes([0x80 | len(out)]) + bytes(out)


def encode_cue(start_ms, end_ms, text):
    value = format_cue_block(start_ms, end_ms, text).encode("utf-8")
    if len(value) > MAX_VALUE_BYTES:
        raise ValueError(f"subtitle cue too large: {len(value)} bytes")
    return KEY + _ber_length(len(value)) + value


def is_subtitle_klv(data):
    return len(data) >= len(KEY) and bytes(data[: len(KEY)]) == KEY


def decode_cue(data):
    """KLV bytes → (start_ms, end_ms, text) or None. Total: never raises."""
    try:
        data = bytes(data)
        if not is_subtitle_klv(data):
            return None
        i = len(KEY)
        if i >= len(data):
            return None
        length = data[i]
        i += 1
        if length & 0x80:
            n = length & 0x7F
            if n == 0 or n > 4 or i + n > len(data):
                return None
            length = int.from_bytes(data[i:i + n], "big")
            i += n
        if length > MAX_VALUE_BYTES or i + length > len(data):
            return None
        block = data[i:i + length].decode("utf-8")
        return parse_cue_block(block)
    except (UnicodeDecodeError, ValueError, IndexError):
        return None
