"""ctypes binding for librist (RIST protocol library).

Replaces the ristreceiver/ristsender CLI relays: instead of the CLI bridging
RIST <-> a loopback UDP socket, the runner drives librist in-process and moves
payloads straight between librist and a GStreamer appsrc/appsink — no
intermediate datagram hop, so RIST modules ride the unixfd bus like any other
gst module.

ABI strategy (validated against librist 0.2.7/API 4.2.0 and 0.2.12/API 4.6.0):
  - `struct rist_data_block` is mirrored fully — identical in both versions.
  - `struct rist_stats` is mirrored only up to `stats_json`; the trailing
    union GREW between 4.2 and 4.6 (receiver peers array), so Python consumes
    the version-stable JSON and never touches the binary stats.
  - `struct rist_peer_config` is OPAQUE: allocated by rist_parse_address2,
    handed to rist_peer_create, freed with rist_peer_config_free2. Every knob
    we need (buffer, secret, aes-type, weight, cname, ...) is expressible as
    a rist:// URL query param (urlparam.h), so the 4.2->4.6 field-type drift
    in that struct can never bite.

Threading: librist runs its own C threads. ctypes releases the GIL during
calls (a blocking data_read2 doesn't stall other Python threads) and acquires
it inside callbacks (stats/log arrive on librist threads). Callback CFUNCTYPE
objects are kept referenced on the instance — GC'ing them while librist holds
the pointer would segfault.
"""

import ctypes
import threading
from ctypes import (
    CFUNCTYPE,
    POINTER,
    Structure,
    byref,
    c_char_p,
    c_int,
    c_size_t,
    c_uint16,
    c_uint32,
    c_uint64,
    c_void_p,
)

# enum rist_profile
RIST_PROFILE_SIMPLE = 0
RIST_PROFILE_MAIN = 1
RIST_PROFILE_ADVANCED = 2

# enum rist_log_level
RIST_LOG_DISABLE = -1
RIST_LOG_ERROR = 3
RIST_LOG_WARN = 4
RIST_LOG_NOTICE = 5
RIST_LOG_INFO = 6
RIST_LOG_DEBUG = 7

_SUPPORTED_API_MAJOR = 4


class RistError(RuntimeError):
    """librist call failed."""


class RistDataBlock(Structure):
    # struct rist_data_block — headers.h, identical in API 4.2.0 and 4.6.0.
    _fields_ = [
        ("payload", c_void_p),
        ("payload_len", c_size_t),
        ("ts_ntp", c_uint64),
        ("virt_src_port", c_uint16),
        ("virt_dst_port", c_uint16),
        ("peer", c_void_p),
        ("flow_id", c_uint32),
        ("seq", c_uint64),
        ("flags", c_uint32),
        ("ref", c_void_p),
    ]


class RistStatsPrefix(Structure):
    # Version-stable PREFIX of struct rist_stats (stats.h). The union that
    # follows `version` changed between API 4.2 and 4.6; never mirror it.
    _fields_ = [
        ("json_size", c_uint32),
        ("stats_json", c_char_p),
        ("version", c_uint16),
    ]


LOG_CB = CFUNCTYPE(c_int, c_void_p, c_int, c_char_p)
STATS_CB = CFUNCTYPE(c_int, c_void_p, POINTER(RistStatsPrefix))


class RistLoggingSettings(Structure):
    # struct rist_logging_settings — logging.h, identical in both versions.
    _fields_ = [
        ("log_level", c_int),
        ("log_cb", LOG_CB),
        ("log_cb_arg", c_void_p),
        ("log_socket", c_int),
        ("log_stream", c_void_p),
    ]


_lib = None
_lib_lock = threading.Lock()


def _load():
    global _lib
    with _lib_lock:
        if _lib is not None:
            return _lib
        lib = ctypes.CDLL("librist.so.4", use_errno=True)

        lib.librist_version.argtypes = []
        lib.librist_version.restype = c_char_p
        lib.librist_api_version.argtypes = []
        lib.librist_api_version.restype = c_char_p

        lib.rist_receiver_create.argtypes = [
            POINTER(c_void_p), c_int, POINTER(RistLoggingSettings)]
        lib.rist_receiver_create.restype = c_int
        lib.rist_sender_create.argtypes = [
            POINTER(c_void_p), c_int, c_uint32, POINTER(RistLoggingSettings)]
        lib.rist_sender_create.restype = c_int

        lib.rist_parse_address2.argtypes = [c_char_p, POINTER(c_void_p)]
        lib.rist_parse_address2.restype = c_int
        lib.rist_peer_config_free2.argtypes = [POINTER(c_void_p)]
        lib.rist_peer_config_free2.restype = c_int
        lib.rist_peer_create.argtypes = [c_void_p, POINTER(c_void_p), c_void_p]
        lib.rist_peer_create.restype = c_int

        lib.rist_start.argtypes = [c_void_p]
        lib.rist_start.restype = c_int
        lib.rist_destroy.argtypes = [c_void_p]
        lib.rist_destroy.restype = c_int

        lib.rist_receiver_set_output_fifo_size.argtypes = [c_void_p, c_uint32]
        lib.rist_receiver_set_output_fifo_size.restype = c_int
        lib.rist_receiver_data_read2.argtypes = [
            c_void_p, POINTER(POINTER(RistDataBlock)), c_int]
        lib.rist_receiver_data_read2.restype = c_int
        lib.rist_receiver_data_block_free2.argtypes = [
            POINTER(POINTER(RistDataBlock))]
        lib.rist_receiver_data_block_free2.restype = None

        lib.rist_sender_data_write.argtypes = [c_void_p, POINTER(RistDataBlock)]
        lib.rist_sender_data_write.restype = c_int
        lib.rist_sender_npd_enable.argtypes = [c_void_p]
        lib.rist_sender_npd_enable.restype = c_int

        lib.rist_stats_callback_set.argtypes = [c_void_p, c_int, STATS_CB, c_void_p]
        lib.rist_stats_callback_set.restype = c_int
        lib.rist_stats_free.argtypes = [POINTER(RistStatsPrefix)]
        lib.rist_stats_free.restype = c_int

        api = (lib.librist_api_version() or b"").decode()
        major = int(api.split(".", 1)[0] or 0) if api else 0
        if major != _SUPPORTED_API_MAJOR:
            raise RistError(
                f"librist API version {api!r} unsupported "
                f"(binding written for major {_SUPPORTED_API_MAJOR})")
        _lib = lib
        return lib


def versions():
    """(library version, API version) strings, e.g. ('v0.2.12...', '4.6.0')."""
    lib = _load()
    return (
        (lib.librist_version() or b"?").decode(),
        (lib.librist_api_version() or b"?").decode(),
    )


def augment_url(url, buffer_ms=None, secret=None, aes_type=None,
                session_timeout_ms=None):
    """Fold the module-level buffer/encryption settings into a rist:// URL as
    query params (urlparam.h) — the same fields the CLI's -b/-s/-e set on the
    parsed peer config. Params already present in the URL win (appended params
    are parsed first come, first served by rist_parse_address2 — so keep ours
    behind the user's by appending)."""
    extra = []
    if buffer_ms and "buffer=" not in url:
        extra.append(f"buffer={int(buffer_ms)}")
    if session_timeout_ms and "session-timeout=" not in url:
        extra.append(f"session-timeout={int(session_timeout_ms)}")
    if secret and "secret=" not in url:
        extra.append(f"secret={secret}")
        if aes_type and "aes-type=" not in url:
            extra.append(f"aes-type={int(aes_type)}")
    if not extra:
        return url
    return url + ("&" if "?" in url else "?") + "&".join(extra)


class _RistCtx:
    """Shared create/peer/start/stats/destroy plumbing for both directions."""

    def __init__(self, log_fn=None, log_level=RIST_LOG_INFO):
        self._lib = _load()
        self._ctx = c_void_p()
        self._lock = threading.Lock()
        self._destroyed = False
        self._stats_cb_ref = None  # keep CFUNCTYPE alive for librist's lifetime
        self._log_fn = log_fn

        def _log_trampoline(_arg, level, msg):
            try:
                if self._log_fn and msg:
                    self._log_fn(int(level), msg.decode(errors="replace").rstrip())
            except Exception:
                pass  # a log handler must never propagate into C
            return 0

        self._log_cb_ref = LOG_CB(_log_trampoline)
        self._logging = RistLoggingSettings(
            log_level=log_level if log_fn else RIST_LOG_DISABLE,
            log_cb=self._log_cb_ref if log_fn else LOG_CB(),
            log_cb_arg=None,
            log_socket=-1,
            log_stream=None,
        )

    def add_peer(self, url):
        """Parse a rist:// URL (all knobs as query params) and add the peer."""
        cfg = c_void_p()
        ret = self._lib.rist_parse_address2(url.encode(), byref(cfg))
        if ret < 0 or not cfg:
            raise RistError(f"rist_parse_address2 failed ({ret}) for {url!r}")
        try:
            peer = c_void_p()
            if self._lib.rist_peer_create(self._ctx, byref(peer), cfg) != 0:
                raise RistError(f"rist_peer_create failed for {url!r}")
        finally:
            self._lib.rist_peer_config_free2(byref(cfg))

    def set_stats_callback(self, interval_ms, fn):
        """fn(stats_json: str) — called on a librist thread; must be thread-safe."""

        def _stats_trampoline(_arg, stats_ptr):
            try:
                if stats_ptr:
                    raw = stats_ptr.contents.stats_json  # copied to bytes by ctypes
                    if raw:
                        fn(raw.decode(errors="replace"))
            except Exception:
                pass  # stats must never propagate into C
            finally:
                if stats_ptr:
                    self._lib.rist_stats_free(stats_ptr)
            return 0

        self._stats_cb_ref = STATS_CB(_stats_trampoline)
        if self._lib.rist_stats_callback_set(
                self._ctx, int(interval_ms), self._stats_cb_ref, None) != 0:
            raise RistError("rist_stats_callback_set failed")

    def start(self):
        if self._lib.rist_start(self._ctx) != 0:
            raise RistError("rist_start failed")

    def destroy(self):
        with self._lock:
            if self._destroyed:
                return
            self._destroyed = True
            ctx, self._ctx = self._ctx, c_void_p()
        if ctx:
            # rist_destroy joins librist's threads, so no callback can fire
            # after it returns — only then is dropping the refs safe.
            self._lib.rist_destroy(ctx)
        self._stats_cb_ref = None

    @property
    def destroyed(self):
        return self._destroyed


class RistReceiver(_RistCtx):
    """RIST receiver: peers -> read() raw payloads (fifo + timeout)."""

    def __init__(self, profile=RIST_PROFILE_MAIN, log_fn=None,
                 fifo_size=2048, log_level=RIST_LOG_INFO):
        super().__init__(log_fn=log_fn, log_level=log_level)
        if self._lib.rist_receiver_create(
                byref(self._ctx), int(profile), byref(self._logging)) != 0:
            raise RistError("rist_receiver_create failed")
        if fifo_size:
            # Power-of-2 packet count; sized before start. 2048 * ~1316B ≈
            # 2.7 MB ≈ 1s @ 20 Mbps of absorption if the appsrc push stalls.
            self._lib.rist_receiver_set_output_fifo_size(
                self._ctx, int(fifo_size))

    def read(self, timeout_ms=100):
        """One payload as bytes, or None on timeout/idle. GIL is released
        while blocked, so a reader thread doesn't stall the interpreter."""
        blk = POINTER(RistDataBlock)()
        ret = self._lib.rist_receiver_data_read2(self._ctx, byref(blk), int(timeout_ms))
        if ret <= 0 or not blk:
            if ret < 0 and not self._destroyed:
                raise RistError(f"rist_receiver_data_read2 failed ({ret})")
            return None
        try:
            d = blk.contents
            if not d.payload or d.payload_len == 0:
                return None
            return ctypes.string_at(d.payload, d.payload_len)
        finally:
            self._lib.rist_receiver_data_block_free2(byref(blk))


class RistSender(_RistCtx):
    """RIST sender: write() raw payloads -> peers."""

    def __init__(self, profile=RIST_PROFILE_MAIN, log_fn=None,
                 npd=False, log_level=RIST_LOG_INFO):
        super().__init__(log_fn=log_fn, log_level=log_level)
        if self._lib.rist_sender_create(
                byref(self._ctx), int(profile), 0, byref(self._logging)) != 0:
            raise RistError("rist_sender_create failed")
        if npd:
            self._lib.rist_sender_npd_enable(self._ctx)

    def write(self, data):
        """Write one payload (librist copies it during the call). Returns
        bytes written; raises on error."""
        blk = RistDataBlock()
        ctypes.memset(byref(blk), 0, ctypes.sizeof(blk))
        # c_char_p(data) points into the bytes object's buffer — valid for the
        # duration of the call because `data` stays referenced; librist copies
        # into its own packet before returning (ts_ntp/seq are lib-populated).
        blk.payload = ctypes.cast(c_char_p(data), c_void_p)
        blk.payload_len = len(data)
        ret = self._lib.rist_sender_data_write(self._ctx, byref(blk))
        if ret < 0:
            raise RistError(f"rist_sender_data_write failed ({ret})")
        return ret
