#!/usr/bin/env python3
"""SAP (RFC 2974) + SDP (RFC 4566 / RFC 7273) for AES67 announce and discovery.

The ONE definition of the session description both AES67 plugins use: the TX
module announces what `build_sdp` produces, the RX module's picker is fed by
what `parse_sdp` reads back off the wire, and neither has a copy of the format
in TypeScript. Pure stdlib, no sockets in here — `mr-sap.py` owns the I/O so
this module stays unit-testable without a network.

Wire shapes, both of which the round-trip tests pin:

  SAP packet    1 byte flags (V=1, A=addr family, R, T=announce/delete, E, C)
                1 byte auth length (in 32-bit words) | 2 bytes msg id hash
                4 bytes originating source (IPv4) | optional auth data
                optional "application/sdp\\0" | the SDP payload

  SDP           the AES67 profile: one audio media line, an `L24`/`L16`
                rtpmap at 48 kHz, `a=ptime`, and — only when the sender can
                actually claim the PTP epoch — the RFC 7273 pair
                `a=ts-refclk:ptp=IEEE1588-2008:<gmid>:<domain>` +
                `a=mediaclk:direct=0`. Announcing that pair on a box whose
                RTP timestamps are free-running is the one thing a receiver
                cannot detect, so it is gated on the sender's real state
                rather than on the operator's intent (see `aes67_clock`).

Not implemented, deliberately: SAP authentication (RFC 2974 §8 — its PGP/CMS
signatures are unused in AES67 practice, and an unverified auth block is worse
than none), compression, and IPv6 announcements. All three are parsed
defensively — an auth header is skipped, a compressed or IPv6 packet is
rejected rather than mis-read.
"""

import time

#: The IPv4 "SAP announcement" group and port every AES67 device listens on.
SAP_GROUP_IPV4 = "239.255.255.255"
SAP_PORT = 9875

#: RFC 2974 derives the interval from a 4000 bps announcement bandwidth budget,
#: floored at 300 s. AES67 practice (Ravenna, Dante, Merging) announces far more
#: often than that because a 300 s discovery latency is unusable in an operator
#: workflow; 30 s is the common value and what we default to.
DEFAULT_ANNOUNCE_INTERVAL_S = 30

#: Drop an un-refreshed session after 10 missed announcements (RFC 2974 §3.1's
#: "10 x the announcement interval" rule), so a sender that vanishes without a
#: deletion packet leaves the picker within a few minutes.
DEFAULT_TIMEOUT_MULTIPLIER = 10

SAP_VERSION = 1
SDP_MIME = b"application/sdp"


def crc16_ccitt(data):
    """CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), table-free.

    Any stable 16-bit function of the payload satisfies RFC 2974's message id
    hash; a CRC is chosen over `hash()` because python's is salted per process,
    which would change our own announcement's identity on every restart.
    """
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def sap_hash(sdp):
    """16-bit message id hash for an SDP body, never 0.

    RFC 2974 gives 0 the special meaning "no hash — compare whole payloads",
    which would make two of our sessions indistinguishable to a receiver that
    keys on it. Mapping the one colliding value to 0xFFFF costs a 1-in-65536
    aliasing and keeps the identity meaningful.
    """
    body = sdp.encode("utf-8") if isinstance(sdp, str) else sdp
    return crc16_ccitt(body) or 0xFFFF


def _ipv4_bytes(addr):
    parts = addr.split(".")
    if len(parts) != 4:
        raise ValueError("not an IPv4 address: %r" % (addr,))
    return bytes(int(p) for p in parts)


def _is_multicast_v4(addr):
    try:
        first = int(addr.split(".", 1)[0])
    except (ValueError, IndexError):
        return False
    return 224 <= first <= 239


def _fmt_ptime(ptime_ms):
    """SDP `a=ptime` — integer when it is one (`1`, not `1.0`), else trimmed.

    AES67's sub-millisecond packet times (0.125 / 0.25 ms) are legal SDP and
    real receivers parse them, but `1.0` where every other implementation
    writes `1` is the kind of cosmetic difference that gets blamed first.
    """
    if float(ptime_ms).is_integer():
        return str(int(ptime_ms))
    return ("%.3f" % float(ptime_ms)).rstrip("0").rstrip(".")


def ts_refclk_attr(ptp_gmid, ptp_domain=0):
    """RFC 7273 reference clock attribute value for a PTPv2 grandmaster."""
    return "ptp=IEEE1588-2008:%s:%d" % (ptp_gmid, int(ptp_domain))


def build_sdp(session_name, source_ip, stream_address, stream_port,
              encoding="L24", rate=48000, channels=2, ptime_ms=1,
              payload_type=96, ttl=None, ptp_gmid=None, ptp_domain=0,
              session_id=None, session_version=None):
    """AES67 session description for one audio stream.

    `session_id`/`session_version` are parameters rather than always-now so the
    round-trip tests are deterministic; a caller that omits them gets the
    conventional NTP-ish seconds. The version must CHANGE when the description
    changes — `mr-sap.py` bumps it when it rebuilds.
    """
    now = int(time.time())
    sid = now if session_id is None else session_id
    sver = now if session_version is None else session_version
    conn = stream_address
    if ttl is not None and _is_multicast_v4(stream_address):
        conn = "%s/%d" % (stream_address, int(ttl))

    lines = [
        "v=0",
        "o=- %d %d IN IP4 %s" % (sid, sver, source_ip),
        "s=%s" % session_name,
        "c=IN IP4 %s" % conn,
        "t=0 0",
        "m=audio %d RTP/AVP %d" % (int(stream_port), int(payload_type)),
        "a=rtpmap:%d %s/%d/%d" % (int(payload_type), encoding, int(rate), int(channels)),
        "a=ptime:%s" % _fmt_ptime(ptime_ms),
        # Written from the RECEIVER's point of view, which is what a SAP
        # announcement is: "here is a stream you may receive". Matches what
        # Ravenna/Dante announce, so third-party receivers don't reject it.
        "a=recvonly",
    ]
    if ptp_gmid:
        lines.append("a=ts-refclk:%s" % ts_refclk_attr(ptp_gmid, ptp_domain))
        # `direct=0` says the RTP timestamp IS the PTP-epoch media clock with no
        # further offset — true exactly when the sender's timestamp-offset was
        # derived from the TAI epoch (aes67_clock.rtp_timestamp_offset).
        lines.append("a=mediaclk:direct=0")
    return "\r\n".join(lines) + "\r\n"


def parse_sdp(text):
    """Parse the fields an AES67 receiver needs. Unknown lines are ignored.

    Returns a dict with `address`/`port`/`encoding`/`rate`/`channels`/
    `payloadType`/`ptimeMs`/`name`/`origin`/`refclk`/`mediaclk`; missing
    optional fields come back as None rather than raising, because a
    third-party announcement is untrusted input arriving on a multicast group
    anyone can write to.
    """
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    out = {
        "name": None, "origin": None, "address": None, "port": None,
        "encoding": None, "rate": None, "channels": None, "payloadType": None,
        "ptimeMs": None, "refclk": None, "mediaclk": None, "sdp": text,
    }
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if len(line) < 2 or line[1] != "=":
            continue
        key, value = line[0], line[2:]
        if key == "s":
            out["name"] = value
        elif key == "o":
            out["origin"] = value
        elif key == "c":
            parts = value.split()
            if len(parts) >= 3:
                out["address"] = parts[2].split("/", 1)[0]
        elif key == "m":
            parts = value.split()
            if len(parts) >= 4 and parts[0] == "audio":
                try:
                    out["port"] = int(parts[1])
                    out["payloadType"] = int(parts[3])
                except ValueError:
                    pass
        elif key == "a":
            _parse_sdp_attribute(value, out)
    return out


def _parse_sdp_attribute(value, out):
    name, _, rest = value.partition(":")
    if name == "rtpmap":
        parts = rest.split()
        if len(parts) >= 2:
            fields = parts[1].split("/")
            out["encoding"] = fields[0]
            if len(fields) > 1:
                try:
                    out["rate"] = int(fields[1])
                except ValueError:
                    pass
            # RFC 4566 lets a mono stream omit the channel count entirely.
            out["channels"] = int(fields[2]) if len(fields) > 2 and fields[2].isdigit() else 1
    elif name == "ptime":
        try:
            out["ptimeMs"] = float(rest)
        except ValueError:
            pass
    elif name == "ts-refclk":
        out["refclk"] = rest
    elif name == "mediaclk":
        out["mediaclk"] = rest


def build_sap_packet(sdp, source_ip, deletion=False, msg_id_hash=None,
                     include_payload_type=True):
    """One SAP announcement (or deletion) packet, ready for the wire."""
    body = sdp.encode("utf-8") if isinstance(sdp, str) else sdp
    flags = SAP_VERSION << 5
    if deletion:
        flags |= 1 << 2
    digest = sap_hash(body) if msg_id_hash is None else (int(msg_id_hash) & 0xFFFF)
    header = bytes([flags, 0, (digest >> 8) & 0xFF, digest & 0xFF]) + _ipv4_bytes(source_ip)
    # RFC 2974 §6: the payload type may be omitted when the payload is SDP, but
    # only a receiver that sniffs for "v=0" copes. Sending it is the compatible
    # choice; parsing without it is the lenient one.
    if include_payload_type:
        header += SDP_MIME + b"\x00"
    return header + body


def parse_sap_packet(data):
    """Parse a SAP packet. Raises ValueError on anything we must not guess at."""
    if len(data) < 8:
        raise ValueError("short SAP packet (%d bytes)" % len(data))
    flags = data[0]
    version = (flags >> 5) & 0x07
    if version != SAP_VERSION:
        raise ValueError("unsupported SAP version %d" % version)
    if flags & 0x10:
        raise ValueError("IPv6 SAP announcement (unsupported)")
    if flags & 0x01:
        raise ValueError("compressed SAP payload (unsupported)")
    encrypted = bool(flags & 0x02)
    deletion = bool(flags & 0x04)
    auth_words = data[1]
    digest = (data[2] << 8) | data[3]
    origin = ".".join(str(b) for b in data[4:8])
    offset = 8 + auth_words * 4
    if offset > len(data):
        raise ValueError("auth header overruns packet")
    payload = data[offset:]
    payload_type = None
    if payload.startswith(SDP_MIME + b"\x00"):
        payload_type = SDP_MIME.decode()
        payload = payload[len(SDP_MIME) + 1:]
    else:
        # Some senders omit the MIME type; others send a different one. Only
        # SDP is meaningful to us, and it always starts with "v=0".
        nul = payload.find(b"\x00")
        if nul != -1 and not payload.startswith(b"v=0") and nul < 64:
            payload_type = payload[:nul].decode("ascii", "replace")
            payload = payload[nul + 1:]
    return {
        "version": version,
        "deletion": deletion,
        "encrypted": encrypted,
        "msgIdHash": digest,
        "origin": origin,
        "payloadType": payload_type,
        "sdp": payload.decode("utf-8", "replace"),
    }


def session_key(origin, msg_id_hash, sdp):
    """Stable identity of an announced session.

    RFC 2974 identifies a session by (originating source, message id hash). A
    sender that leaves the hash at 0 (legal, meaning "compare payloads") would
    collapse all of its sessions onto one key, so we substitute our own hash of
    the body in that case.
    """
    digest = msg_id_hash or sap_hash(sdp)
    return "%s/%04x" % (origin, digest)


class DiscoveryTable:
    """Announced sessions seen on the SAP group, aged out when they stop.

    Keyed by `session_key`, so a sender re-announcing the same session refreshes
    its entry (and a changed description, which changes the hash, arrives as a
    NEW entry — the old one ages out). Deletion packets remove immediately.
    """

    def __init__(self, interval_s=DEFAULT_ANNOUNCE_INTERVAL_S,
                 timeout_s=None, clock=time.monotonic):
        self.timeout_s = (
            interval_s * DEFAULT_TIMEOUT_MULTIPLIER if timeout_s is None else timeout_s
        )
        self._clock = clock
        self._entries = {}

    def feed(self, data, source_ip=None, now=None):
        """Absorb one raw SAP packet.

        Returns `(action, entry)` where action is 'added', 'updated', 'removed'
        or None (unparseable / not an audio SDP / already gone). Never raises on
        malformed input: this reads a group anyone on the LAN can write to.
        """
        now = self._clock() if now is None else now
        try:
            packet = parse_sap_packet(data)
        except ValueError:
            return (None, None)
        if packet["encrypted"]:
            return (None, None)
        sdp = parse_sdp(packet["sdp"])
        if not sdp["address"] or not sdp["port"]:
            return (None, None)
        key = session_key(packet["origin"], packet["msgIdHash"], packet["sdp"])
        if packet["deletion"]:
            removed = self._entries.pop(key, None)
            return ("removed", removed) if removed else (None, None)
        existing = self._entries.get(key)
        entry = {
            "key": key,
            "origin": packet["origin"],
            "sourceIp": source_ip,
            "name": sdp["name"] or "%s:%s" % (sdp["address"], sdp["port"]),
            "address": sdp["address"],
            "port": sdp["port"],
            "encoding": sdp["encoding"],
            "rate": sdp["rate"],
            "channels": sdp["channels"],
            "payloadType": sdp["payloadType"],
            "ptimeMs": sdp["ptimeMs"],
            "refclk": sdp["refclk"],
            "mediaclk": sdp["mediaclk"],
            "sdp": packet["sdp"],
            "firstSeen": existing["firstSeen"] if existing else now,
            "lastSeen": now,
        }
        self._entries[key] = entry
        return ("updated" if existing else "added", entry)

    def prune(self, now=None):
        """Drop sessions not refreshed within the timeout. Returns removed entries."""
        now = self._clock() if now is None else now
        stale = [k for k, e in self._entries.items() if now - e["lastSeen"] > self.timeout_s]
        return [self._entries.pop(k) for k in stale]

    def entries(self, now=None):
        """Live sessions, oldest-first — pruning as a side effect."""
        self.prune(now)
        return sorted(self._entries.values(), key=lambda e: (e["name"], e["key"]))
