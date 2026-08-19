#!/usr/bin/env python3
"""Logic tests for aes67_sap.py (no sockets). Run: python3 aes67_sap_test.py"""
import aes67_sap as s


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


# --- hashing ---------------------------------------------------------------
# CRC-16/CCITT-FALSE canonical check value, so the hash is pinned to a standard
# and not merely to itself.
check("crc16/ccitt check value", s.crc16_ccitt(b"123456789") == 0x29B1)
check("sap_hash is stable across calls", s.sap_hash("v=0\r\n") == s.sap_hash("v=0\r\n"))
check("sap_hash accepts str and bytes alike", s.sap_hash("v=0") == s.sap_hash(b"v=0"))
check("sap_hash changes with the body", s.sap_hash("v=0\r\ns=a") != s.sap_hash("v=0\r\ns=b"))
# 0 is RFC 2974's "no hash, compare payloads" — never our identity.
check("sap_hash never returns 0", all(s.sap_hash(bytes([i, i, i])) != 0 for i in range(256)))

# --- SDP build -------------------------------------------------------------
sdp = s.build_sdp(
    session_name="Studio A", source_ip="10.9.1.42",
    stream_address="239.69.0.1", stream_port=5004,
    encoding="L24", rate=48000, channels=2, ptime_ms=1,
    payload_type=98, ttl=16, session_id=1234, session_version=1234)
lines = sdp.split("\r\n")
check("sdp starts with v=0", lines[0] == "v=0")
check("sdp origin", lines[1] == "o=- 1234 1234 IN IP4 10.9.1.42")
check("sdp connection carries the multicast ttl", "c=IN IP4 239.69.0.1/16" in lines)
check("sdp media line", "m=audio 5004 RTP/AVP 98" in lines)
check("sdp rtpmap", "a=rtpmap:98 L24/48000/2" in lines)
check("sdp ptime is an integer when it is one", "a=ptime:1" in lines)
check("sdp is recvonly (announcement is written for the receiver)", "a=recvonly" in lines)
# No PTP grandmaster => NO RFC 7273 pair. Claiming ts-refclk/mediaclk while the
# sender's RTP timestamps free-run is undetectable at the receiver, so it is
# gated on the sender's real state, not on the operator's intent.
check("no ts-refclk without a grandmaster", "ts-refclk" not in sdp)
check("no mediaclk without a grandmaster", "mediaclk" not in sdp)

sdp_ptp = s.build_sdp(
    session_name="Studio A", source_ip="10.9.1.42", stream_address="239.69.0.1",
    stream_port=5004, ptp_gmid="00-1D-C1-FF-FE-50-30-EE", ptp_domain=0,
    session_id=1, session_version=1)
check("ts-refclk names the grandmaster and domain",
      "a=ts-refclk:ptp=IEEE1588-2008:00-1D-C1-FF-FE-50-30-EE:0" in sdp_ptp)
check("mediaclk direct=0 rides with it", "a=mediaclk:direct=0" in sdp_ptp)

# Unicast destination takes no /ttl suffix (RFC 4566: TTL is multicast-only).
uni = s.build_sdp(session_name="x", source_ip="10.0.0.1", stream_address="10.0.0.9",
                  stream_port=5004, ttl=16, session_id=1, session_version=1)
check("unicast connection has no /ttl", "c=IN IP4 10.0.0.9" in uni.split("\r\n"))

# Sub-millisecond packet times are legal AES67 and must survive formatting.
frac = s.build_sdp(session_name="x", source_ip="10.0.0.1", stream_address="239.69.0.1",
                   stream_port=5004, ptime_ms=0.125, session_id=1, session_version=1)
check("fractional ptime formats without trailing zeros", "a=ptime:0.125" in frac)

# --- SDP parse (round-trip) ------------------------------------------------
p = s.parse_sdp(sdp_ptp)
check("parse address", p["address"] == "239.69.0.1")
check("parse port", p["port"] == 5004)
check("parse encoding/rate/channels",
      (p["encoding"], p["rate"], p["channels"]) == ("L24", 48000, 2))
check("parse payload type", p["payloadType"] == 96)
check("parse ptime", p["ptimeMs"] == 1.0)
check("parse name", p["name"] == "Studio A")
check("parse refclk", p["refclk"] == "ptp=IEEE1588-2008:00-1D-C1-FF-FE-50-30-EE:0")
check("parse mediaclk", p["mediaclk"] == "direct=0")

# A third-party sender: LF line endings, mono rtpmap with the channel count
# omitted (legal per RFC 4566), attributes we don't know.
foreign = ("v=0\n"
           "o=- 3 3 IN IP4 192.168.1.5\n"
           "s=Mono Feed\n"
           "c=IN IP4 239.1.2.3/32\n"
           "t=0 0\n"
           "a=clock-domain:PTPv2 0\n"
           "m=audio 5006 RTP/AVP 97\n"
           "a=rtpmap:97 L16/48000\n"
           "a=ptime:4\n"
           "a=sendonly\n")
f = s.parse_sdp(foreign)
check("foreign sdp: LF line endings parse", f["address"] == "239.1.2.3" and f["port"] == 5006)
check("foreign sdp: omitted channel count reads as mono", f["channels"] == 1)
check("foreign sdp: L16 encoding", f["encoding"] == "L16")
check("foreign sdp: unknown attributes are ignored", f["refclk"] is None)

# Garbage must come back empty, never raise: this is a group anyone can write to.
g = s.parse_sdp("\x00\x01not an sdp at all")
check("garbage sdp yields no address/port", g["address"] is None and g["port"] is None)

# --- SAP packet round-trip -------------------------------------------------
pkt = s.build_sap_packet(sdp, "10.9.1.42")
check("sap version 1, announcement", pkt[0] == (1 << 5))
check("sap auth length 0 (unauthenticated)", pkt[1] == 0)
check("sap msg id hash matches the body", ((pkt[2] << 8) | pkt[3]) == s.sap_hash(sdp))
check("sap origin is the source address", pkt[4:8] == bytes([10, 9, 1, 42]))
check("sap payload type present", pkt[8:8 + 16] == b"application/sdp\x00")

r = s.parse_sap_packet(pkt)
check("round-trip sdp is byte-identical", r["sdp"] == sdp)
check("round-trip origin", r["origin"] == "10.9.1.42")
check("round-trip hash", r["msgIdHash"] == s.sap_hash(sdp))
check("round-trip is not a deletion", r["deletion"] is False)

deletion = s.parse_sap_packet(s.build_sap_packet(sdp, "10.9.1.42", deletion=True))
check("deletion flag round-trips", deletion["deletion"] is True)

# Senders that omit the MIME type (RFC 2974 §6 allows it for SDP).
bare = s.parse_sap_packet(s.build_sap_packet(sdp, "10.9.1.42", include_payload_type=False))
check("payload type may be absent", bare["sdp"] == sdp and bare["payloadType"] is None)

# Auth data we do not verify must still be SKIPPED, not fed into the parser.
authed = bytearray(s.build_sap_packet(sdp, "10.9.1.42"))
authed[1] = 2                                    # 2 words = 8 bytes of auth
authed[8:8] = b"\xde\xad\xbe\xef\xde\xad\xbe\xef"
a = s.parse_sap_packet(bytes(authed))
check("auth header is skipped", a["sdp"] == sdp)

for bad, why in [(b"", "empty"), (b"\x01\x02\x03", "short"),
                 (bytes([0 << 5, 0, 0, 0, 1, 2, 3, 4]), "version 0"),
                 (bytes([(1 << 5) | 0x10, 0, 0, 0, 1, 2, 3, 4]), "ipv6"),
                 (bytes([(1 << 5) | 0x01, 0, 0, 0, 1, 2, 3, 4]), "compressed"),
                 (bytes([1 << 5, 99, 0, 0, 1, 2, 3, 4]), "auth overrun")]:
    try:
        s.parse_sap_packet(bad)
        check("rejects %s" % why, False)
    except ValueError:
        check("rejects %s" % why, True)

# --- discovery table -------------------------------------------------------
t = s.DiscoveryTable(interval_s=30)
action, entry = t.feed(pkt, source_ip="10.9.1.42", now=0)
check("first announcement adds", action == "added")
check("entry carries the stream parameters",
      (entry["address"], entry["port"], entry["encoding"], entry["channels"])
      == ("239.69.0.1", 5004, "L24", 2))
check("entry key is origin/hash", entry["key"] == "10.9.1.42/%04x" % s.sap_hash(sdp))

action, entry = t.feed(pkt, source_ip="10.9.1.42", now=30)
check("re-announcement updates rather than duplicates", action == "updated")
check("firstSeen is preserved across the refresh", entry["firstSeen"] == 0)
check("lastSeen advances", entry["lastSeen"] == 30)
check("still exactly one session", len(t.entries(now=30)) == 1)

# Aged out at 10x the interval (RFC 2974 §3.1).
check("alive just before the timeout", len(t.entries(now=30 + 300)) == 1)
check("aged out just after", len(t.entries(now=30 + 301)) == 0)

# A second sender, and a deletion that removes only its own session.
t2 = s.DiscoveryTable(interval_s=30)
other_sdp = s.build_sdp(session_name="Studio B", source_ip="10.9.1.43",
                        stream_address="239.69.0.2", stream_port=5004,
                        session_id=9, session_version=9)
t2.feed(pkt, source_ip="10.9.1.42", now=0)
t2.feed(s.build_sap_packet(other_sdp, "10.9.1.43"), source_ip="10.9.1.43", now=0)
check("two senders, two entries", len(t2.entries(now=0)) == 2)
action, removed = t2.feed(s.build_sap_packet(sdp, "10.9.1.42", deletion=True),
                          source_ip="10.9.1.42", now=1)
check("deletion removes", action == "removed" and removed["name"] == "Studio A")
check("only the deleted session went", [e["name"] for e in t2.entries(now=1)] == ["Studio B"])
check("deleting an unknown session is a no-op",
      t2.feed(s.build_sap_packet(sdp, "10.9.1.42", deletion=True), now=2) == (None, None))

# Malformed / irrelevant traffic on the group must not disturb the table.
check("garbage packet ignored", t2.feed(b"\x00\x01\x02", now=3) == (None, None))
check("non-audio sdp ignored",
      t2.feed(s.build_sap_packet("v=0\r\no=- 1 1 IN IP4 10.0.0.1\r\ns=x\r\nt=0 0\r\n",
                                 "10.0.0.1"), now=3) == (None, None))
check("table survived the garbage", len(t2.entries(now=3)) == 1)

# A changed description changes the hash, i.e. arrives as a NEW session while
# the old one ages out — the property the picker's identity relies on.
changed = s.build_sdp(session_name="Studio A", source_ip="10.9.1.42",
                      stream_address="239.69.0.9", stream_port=5004,
                      session_id=1234, session_version=1235)
t3 = s.DiscoveryTable(interval_s=30)
t3.feed(pkt, now=0)
t3.feed(s.build_sap_packet(changed, "10.9.1.42"), now=0)
check("a changed description is a distinct session", len(t3.entries(now=0)) == 2)

print("\nall aes67_sap tests passed")
