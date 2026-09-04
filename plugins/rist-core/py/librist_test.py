"""Unit tests for librist.py's librist-quirk handling.

Runs without a librist.so: `librist._lib` is replaced by a fake that mimics
the handful of entry points RistSender touches.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import librist  # noqa: E402


class _FakeLib:
    """Minimal stand-in for the ctypes CDLL handle."""

    def __init__(self, legacy_stats_api=True):
        self.stats_interval = None
        self.legacy_stats_interval = None
        if legacy_stats_api:
            self.rist_sender_stats_callback_set = self._legacy_set

    def _legacy_set(self, _ctx, interval_ms, _cb, _arg):
        self.legacy_stats_interval = interval_ms
        return 0

    def rist_sender_create(self, ctx_ref, _profile, _flow_id, _logging):
        ctx_ref._obj.value = 1  # non-NULL handle
        return 0

    def rist_sender_npd_enable(self, _ctx):
        return 0

    def rist_stats_callback_set(self, _ctx, interval_ms, _cb, _arg):
        self.stats_interval = interval_ms
        return 0

    def rist_destroy(self, _ctx):
        return 0


class SenderStatsIntervalTest(unittest.TestCase):
    def setUp(self):
        self._saved_lib = librist._lib

    def tearDown(self):
        librist._lib = self._saved_lib

    def test_sender_stats_interval_is_set_on_both_librist_paths(self):
        # librist quirk: rist_stats_callback_set() sets only the common
        # interval; the sender thread paces from its own copy, which only the
        # legacy rist_sender_stats_callback_set() writes. Left at 0 the sender
        # reports on every loop iteration.
        librist._lib = _FakeLib()
        s = librist.RistSender(profile=2)
        s.set_stats_callback(1000, lambda _json: None)
        s.destroy()
        self.assertEqual(librist._lib.stats_interval, 1000)
        self.assertEqual(librist._lib.legacy_stats_interval, 1000)

    def test_missing_legacy_api_is_tolerated(self):
        librist._lib = _FakeLib(legacy_stats_api=False)
        s = librist.RistSender(profile=2)
        s.set_stats_callback(1000, lambda _json: None)  # must not raise
        s.destroy()
        self.assertEqual(librist._lib.stats_interval, 1000)


if __name__ == "__main__":
    unittest.main(verbosity=1)
