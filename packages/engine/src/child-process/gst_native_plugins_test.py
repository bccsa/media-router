#!/usr/bin/env python3
"""Tests for the house-clock plugin loader (plan ch. 3 WI-S0-8): the description rewrite of
gst_native_plugins.py, and `mrtshouse_load_case` against the python runner, which
native_runner_protocol_test.py runs against mr-gst-runner too: plugin present, missing, without a
stand-in, and below the runners' ABI. Skips (exit 0) without GStreamer or the built plugin."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(sys.argv)
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_native_plugins_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import gst_native_plugins as gnp  # noqa: E402

_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".."))
_PLUGINS = os.path.join(_ROOT, "plugins")
_HOUSE = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse")
_SO = os.path.join(_HOUSE, "libgstmrtshouse.so")
_NATIVE = os.path.join(_ROOT, "packages", "engine", "native", "mr-gst-runner")
PY_RUNNER = [sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]

with open(os.path.join(_HOUSE, "mrtshouse_abi.h"), encoding="utf-8") as fh:
    _abi_h = fh.read()
ABI = int(re.search(r"#define MRTSHOUSE_ABI (\d+)", _abi_h).group(1))
VERSION = re.search(r'#define MRTSHOUSE_VERSION "([^"]+)"', _abi_h).group(1)
# The rule-6 sentence as plan ch. 3 part 4.5 fixes it; both runners must send exactly this.
ALARM = ("Native TS module not loaded: this stream carries no house time on the bus; consumers "
         "will mis-time it until the deploy is fixed.")
TABLE = gnp.PLUGINS[0]["factories"]

# (description, rewritten or None when refused, stand-in names, refused factory).
REWRITE_CASES = [
    ("src ! mrtsrestamp name=p ! sink", "src ! identity name=p ! sink", ["p"], None),
    ('src ! mrtsrestamp foo=1 name=p bar="x y" ! sink', "src ! identity name=p ! sink",
     ["p"], None),
    ('src ! mrtsrestamp  name = "restamp_b"  offset-ns = 5 ! sink',
     'src ! identity  name = "restamp_b" ! sink', ["restamp_b"], None),
    ("src ! mrtsrestamp foo=1 ! sink", "src ! identity ! sink", [], None),
    ('src ! mrtsrestamp bogus="a ! mrtsdemux" name=q ! sink', "src ! identity name=q ! sink",
     ["q"], None),
    ("src ! audio/x-raw, format=S16LE, note=mrtsdemux ! mrtsrestamp ! sink",
     "src ! audio/x-raw, format=S16LE, note=mrtsdemux ! identity ! sink", [], None),
    ("src ! queue name=mrtsdemux ! fakesink name=mrtsrestamp",
     "src ! queue name=mrtsdemux ! fakesink name=mrtsrestamp", [], None),
    ("tee name=t t. ! queue ! mrtsrestamp name=a ! sink t. ! mrtsrestamp name=b ! sink",
     "tee name=t t. ! queue ! identity name=a ! sink t. ! identity name=b ! sink", ["a", "b"],
     None),
    ("src !mrtsrestamp!sink", "src !identity!sink", [], None),
    ("src ! mrtsdemux name=d ! sink", None, [], "mrtsdemux"),
    ("src ! mrtsrestamp name=p ! mrtsdemux ! sink", None, [], "mrtsdemux"),
    ("src ! mrtsrestamp2 ! mrtsdemuxer ! sink", "src ! mrtsrestamp2 ! mrtsdemuxer ! sink",
     [], None),
    ("( src ! mrtsrestamp name=inbin ) ! sink", "( src ! identity name=inbin ) ! sink",
     ["inbin"], None),
    ('src ! mrtsrestamp name="q\\"r" ! sink', 'src ! identity name="q\\"r" ! sink', ['q"r'],
     None),
    ("src ! mrtsrestamp name='x y' ! sink", "src ! identity name='x y' ! sink", ["'x y'"],
     None),
    ("file:///tmp/mrtsdemux ! mrtsrestamp ! sink", "file:///tmp/mrtsdemux ! identity ! sink",
     [], None),
    ("src ! mrtsrestamp name=p sub::prop=1 ! sink", "src ! identity name=p ! sink", ["p"],
     None),
    ("src ! mrtsrestamp name=p", "src ! identity name=p", ["p"], None),
    ("src ! mrtsrestamp x=a\\ b name=p ! sink", "src ! identity name=p ! sink", ["p"], None),
    ("src\t!\nmrtsrestamp\tname=p\tfoo=1\n! sink", "src\t!\nidentity\tname=p\n! sink", ["p"],
     None),
    ("src\t!\fmrtsrestamp\tname=p\vfoo=1\f! sink", "src\t!\fidentity\tname=p\f! sink", ["p"],
     None),
    ("filesrc location=/x/mrtsdemux ! sink", "filesrc location=/x/mrtsdemux ! sink", [], None),
    # The first `name=` names it, as in GStreamer, even an empty one.
    ('src ! mrtsrestamp name="" name=x ! sink', 'src ! identity name="" name=x ! sink', [],
     None),
    # Words of a caps filter are not elements, and neither is a reference to an element.
    ("src ! audio/x-raw, format=(string) mrtsdemux ! sink",
     "src ! audio/x-raw, format=(string) mrtsdemux ! sink", [], None),
    ("tee name=mrtsdemux ! q  mrtsdemux. ! sink", "tee name=mrtsdemux ! q  mrtsdemux. ! sink", [],
     None),
    ("src ! mrtsdemux.src ! mrtsrestamp ! sink", "src ! mrtsdemux.src ! identity ! sink", [],
     None),
]

# Runs once rewritten (the dropped properties would fail on the real element).
RICH = ("audiotestsrc is-live=true ! audio/x-raw, format=S16LE, rate=48000, channels=2"
        " ! mrtsrestamp name=restamp_a desync-bytes=3 ! queue name=mrtsdemux"
        ' ! mrtsrestamp  name = "restamp_b" bogus="x ! y" ! fakesink sync=false')
# Audio is no TS, so the real restamp passes none of it: the sink must not wait to preroll.
TIMING = "audiotestsrc is-live=true ! mrtsrestamp name=restamp ! fakesink sync=false async=false"


def ev_is(name, **fields):
    return lambda ev: ev.get("event") == name and all(ev.get(k) == v for k, v in fields.items())


def timing_alarm(ev):
    return ev.get("kind") == "timing_plugin"


class Runner:
    """One runner process on the stdin/stderr JSON protocol, with its own plugin roots."""

    def __init__(self, argv, plugins_dir, libexec_dir):
        env = dict(os.environ, MR_PLUGINS_DIR=plugins_dir, MR_LIBEXEC_DIR=libexec_dir,
                   MALLOC_ARENA_MAX="2")
        # By path or not at all: the plugin's own dir never on the scan path.
        scan = [d for d in env.get("GST_PLUGIN_PATH", "").split(":") if d and "mrtshouse" not in d]
        env["GST_PLUGIN_PATH"] = ":".join(scan)
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        os.set_blocking(self.proc.stderr.fileno(), False)
        self.events, self.logs, self._buf = [], [], ""

    def send(self, cmd):
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def pump(self):
        try:
            chunk = self.proc.stderr.read()
        except (TypeError, BlockingIOError):
            chunk = None
        if chunk:
            self._buf += chunk
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.startswith("GST_JSON:"):
                    self.events.append(json.loads(line[9:]))
                elif line.strip():
                    self.logs.append(line)

    def wait_event(self, pred, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            for ev in self.events:
                if pred(ev):
                    return ev
            if self.proc.poll() is not None:
                self.pump()
                return next((ev for ev in self.events if pred(ev)), None)
            time.sleep(0.02)
        return None

    def first(self, pred):
        self.pump()
        return next((i for i, ev in enumerate(self.events) if pred(ev)), None)

    def log_after(self, marker):
        """The text after `marker` in the first log line holding it, or None."""
        self.pump()
        return next((l.split(marker, 1)[1] for l in self.logs if marker in l), None)

    def close(self):
        try:
            self.send({"cmd": "stop"})
            self.proc.wait(timeout=10)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            self.proc.kill()
            self.proc.wait()
        self.pump()


STAND_INS = "native TS module not loaded, parsing with stand-ins: "
LOAD_LINE = "native plugin mrtshouse "


def _start(argv, plugins_dir, libexec_dir, pipeline):
    r = Runner(argv, plugins_dir, libexec_dir)
    r.send({"cmd": "start", "pipeline": pipeline})
    r.wait_event(lambda e: e.get("event") in ("started", "error"))
    return r


def build_stub():
    """The ABI-0 build of the plugin (`make -C mrtshouse stub`), or None without make."""
    try:
        done = subprocess.run(["make", "-s", "-C", _HOUSE, "stub"], capture_output=True,
                              text=True, timeout=600)
    except FileNotFoundError:
        return None
    stub = os.path.join(_HOUSE, "tests", "abi0", "libgstmrtshouse.so")
    if done.returncode != 0 or not os.path.exists(stub):
        raise RuntimeError(f"make stub failed: {done.stdout}{done.stderr}")
    return stub


def tree(root, rel, target):
    """`root/rel` as a symlink to `target`, its parents created."""
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.symlink(target, path)
    return path


def mrtshouse_load_case(argv, tag, check, vectors=False):
    """Plan ch. 3 WI-S0-8's `mrtshouse-load` through `argv`'s runner. `vectors`: also run every
    REWRITE_CASES description through it, for a runner whose rewrite is not this module's."""
    if not os.path.exists(_SO):
        print(f"SKIP {tag} mrtshouse-load — {_SO} not built (make native)")
        return
    tmp = tempfile.mkdtemp(prefix="mrhouse-")
    empty = os.path.join(tmp, "empty")
    os.makedirs(empty)
    tried = [os.path.join(empty, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so"),
             os.path.join(empty, "mpegts-core", "libgstmrtshouse.so")]
    missing = f"libgstmrtshouse.so not loaded, tried {', '.join(tried)}"
    try:
        # --- present: the load line, the plugin's element in place ----------------------------
        r = _start(argv, _PLUGINS, empty, TIMING)
        try:
            loaded = r.log_after(LOAD_LINE)
            check(f"{tag} present: one load line `native plugin mrtshouse {VERSION} abi {ABI} from "
                  f"<plugins tree>` (got {loaded!r})", loaded == f"{VERSION} abi {ABI} from {_SO}")
            started = r.wait_event(ev_is("started"))
            check(f"{tag} present: `started` reports the plugin (got {started})",
                  started is not None and started.get("timingPlugin")
                  == {"version": VERSION, "abi": ABI, "path": _SO})
            check(f"{tag} present: no timing_plugin warning", r.first(timing_alarm) is None)
            check(f"{tag} present: reaches PLAYING",
                  r.wait_event(ev_is("state_change", state="playing")) is not None)
            r.send({"cmd": "get_property", "id": "g1", "element": "restamp", "property": "abi"})
            got = r.wait_event(ev_is("property", id="g1"))
            check(f"{tag} present: `restamp` is the plugin's element (abi {ABI})",
                  got is not None and got.get("value") == ABI)
        finally:
            r.close()

        # --- missing: the warning with the tried paths, identity in place, set_property warned
        r = _start(argv, empty, empty, RICH)
        try:
            warn = r.wait_event(lambda e: e.get("event") == "warning" and timing_alarm(e))
            check(f"{tag} missing: `warning` kind timing_plugin lists the tried paths "
                  f"(got {warn})", warn is not None and warn.get("detail") == missing
                  and warn.get("message") == f"{ALARM} ({missing})")
            started = r.wait_event(ev_is("started"))
            order = (r.first(timing_alarm), r.first(ev_is("started")))
            check(f"{tag} missing: the warning precedes `started`, which reports no plugin",
                  started is not None and started.get("timingPlugin") is None
                  and None not in order and order[0] < order[1])
            check(f"{tag} missing: no load line", r.log_after(LOAD_LINE) is None)
            want, _, _ = gnp.rewrite(RICH, TABLE)
            got = r.log_after(STAND_INS)
            check(f"{tag} missing: the parsed description is the twin rewrite (got {got!r})",
                  got == want)
            check(f"{tag} missing: the stood-in pipeline reaches PLAYING",
                  r.wait_event(ev_is("state_change", state="playing")) is not None)
            r.send({"cmd": "get_property", "id": "g1", "element": "restamp_a",
                    "property": "silent"})
            r.send({"cmd": "get_property", "id": "g2", "element": "restamp_b", "property": "abi"})
            got = r.wait_event(ev_is("property", id="g1"))
            check(f"{tag} missing: restamp_a is an identity (its `silent` reads)",
                  got is not None and got.get("value") is True)
            check(f"{tag} missing: restamp_b has no `abi`: no element of the plugin runs",
                  r.wait_event(ev_is("command_error", id="g2")) is not None)
            r.send({"cmd": "set_property", "id": "s1", "element": "restamp_a",
                    "property": "offset-ns", "value": 5})
            r.send({"cmd": "set_property", "id": "s2", "element": "mrtsdemux",
                    "property": "max-size-buffers", "value": 7})
            got = r.wait_event(ev_is("warning", id="s1"))
            check(f"{tag} missing: set_property on a stand-in is answered with a warning "
                  f"(got {got})",
                  got is not None and "restamp_a.offset-ns" in got.get("message", "")
                  and r.first(ev_is("command_error", id="s1")) is None
                  and r.first(ev_is("property_set", id="s1")) is None)
            check(f"{tag} missing: set_property on any other element still sets",
                  r.wait_event(ev_is("property_set", id="s2")) is not None)
            check(f"{tag} missing: no pipeline error",
                  r.first(ev_is("error")) is None)
        finally:
            r.close()

        # --- each element of the table: its stand-in, or the start refused ---------------------
        for factory, stand in TABLE.items():
            desc = f"audiotestsrc is-live=true ! {factory} name=tw ! fakesink sync=false"
            r = _start(argv, empty, empty, desc)
            try:
                if stand is None:
                    err = r.wait_event(lambda e: e.get("event") == "error" and timing_alarm(e))
                    detail = f"{missing}; {factory} has no stand-in"
                    check(f"{tag} missing: a description naming {factory} is refused with the "
                          f"rule-6 text (got {err})", err is not None
                          and err.get("detail") == detail
                          and err.get("message") == f"{ALARM} ({detail})")
                    check(f"{tag} missing: {factory}'s module does not start",
                          r.first(ev_is("started")) is None)
                else:
                    check(f"{tag} missing: {factory} stands in as {stand}",
                          r.log_after(STAND_INS)
                          == f"audiotestsrc is-live=true ! {stand} name=tw ! fakesink sync=false")
                    check(f"{tag} missing: {factory}'s stand-in reaches PLAYING",
                          r.wait_event(ev_is("state_change", state="playing")) is not None)
            finally:
                r.close()

        # --- below the runners' ABI: refused even with a good copy in libexec ------------------
        stub = build_stub()
        if stub is None:
            print(f"SKIP {tag} mrtshouse-load ABI — no make to build the ABI-0 stub")
        else:
            plugins = os.path.join(tmp, "stale")
            stale = tree(plugins, "mpegts-core/native/mrtshouse/libgstmrtshouse.so", stub)
            libexec = os.path.join(tmp, "libexec")
            tree(libexec, "mpegts-core/libgstmrtshouse.so", _SO)
            old = f"libgstmrtshouse.so abi 0 < {gnp.MRTSHOUSE_MIN_ABI}: {stale}"
            r = _start(argv, plugins, libexec, TIMING)
            try:
                warn = r.wait_event(lambda e: e.get("event") == "warning" and timing_alarm(e))
                check(f"{tag} stale: `warning` names both ABI numbers and the path (got {warn})",
                      warn is not None and warn.get("detail") == old
                      and warn.get("message") == f"{ALARM} ({old})")
                check(f"{tag} stale: neither copy is loaded (no load line)",
                      r.log_after(LOAD_LINE) is None)
                started = r.wait_event(ev_is("started"))
                check(f"{tag} stale: `started` reports no plugin",
                      started is not None and started.get("timingPlugin") is None)
                check(f"{tag} stale: identity stands in",
                      r.log_after(STAND_INS) == TIMING.replace("mrtsrestamp", "identity"))
                check(f"{tag} stale: the stood-in pipeline reaches PLAYING",
                      r.wait_event(ev_is("state_change", state="playing")) is not None)
                r.send({"cmd": "get_property", "id": "g1", "element": "restamp", "property": "abi"})
                check(f"{tag} stale: the stale element is not used (`restamp` has no abi)",
                      r.wait_event(ev_is("command_error", id="g1")) is not None)
            finally:
                r.close()
            r = _start(argv, plugins, libexec, "audiotestsrc ! mrtsdemux name=d ! fakesink")
            try:
                err = r.wait_event(lambda e: e.get("event") == "error" and timing_alarm(e))
                detail = f"{old}; mrtsdemux has no stand-in"
                check(f"{tag} stale: mrtsdemux is refused with the rule-6 text (got {err})",
                      err is not None and err.get("detail") == detail
                      and err.get("message") == f"{ALARM} ({detail})")
            finally:
                r.close()
            # A fragment the start rewrite never sees cannot reach the stale element either.
            mix = "audiotestsrc is-live=true ! funnel name=fin ! fakesink sync=false async=false"
            r = _start(argv, plugins, libexec, mix)
            try:
                r.wait_event(ev_is("state_change", state="playing"))
                r.send({"cmd": "bus_input_add", "id": "a1", "element": "fin", "name": "fin_in_x",
                        "description": "audiotestsrc is-live=true ! mrtsrestamp name=stale_in"})
                got = r.wait_event(lambda e: e.get("id") == "a1")
                check(f"{tag} stale: the plugin is out of the registry, so a bus_input_add "
                      f"naming its element fails to parse (got {got})",
                      got is not None and got.get("event") == "command_error"
                      and 'no element "mrtsrestamp"' in got.get("message", ""))
            finally:
                r.close()

        # --- the rewrite vectors through this runner -------------------------------------------
        # A rewritten newline cannot come back through a log line; those stay in-process.
        one_line = [c for c in REWRITE_CASES if "\n" not in c[0]]
        for desc, want, _, refused in one_line if vectors else []:
            r = _start(argv, empty, empty, desc)
            try:
                if refused:
                    err = r.first(lambda e: e.get("event") == "error" and timing_alarm(e))
                    got = r.events[err].get("detail", "") if err is not None else None
                    check(f"{tag} vector refused ({refused}): {desc!r}",
                          got is not None and got.endswith(f"; {refused} has no stand-in"))
                else:
                    got = r.log_after(STAND_INS)
                    check(f"{tag} vector {desc!r} -> {got!r}",
                          got == (None if want == desc else want)
                          and r.first(lambda e: e.get("event") == "error" and timing_alarm(e))
                          is None)
            finally:
                r.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def unit_cases(check):
    """The python rewrite, and the twin tables and constants it must share with the C++."""
    for desc, want, names, refused in REWRITE_CASES:
        got = gnp.rewrite(desc, TABLE)
        check(f"rewrite {desc!r} -> {got[0]!r} {got[1]} {got[2]}", got == (want, names, refused))
    with open(os.path.join(_NATIVE, "native_plugins.h"), encoding="utf-8") as fh:
        header = fh.read()
    with open(os.path.join(_NATIVE, "native_plugins.cpp"), encoding="utf-8") as fh:
        source = fh.read()
    native_min = int(re.search(r"MRTSHOUSE_MIN_ABI = (\d+);", header).group(1))
    check(f"MRTSHOUSE_MIN_ABI is one number in both runners ({gnp.MRTSHOUSE_MIN_ABI}, "
          f"{native_min}), at most the plugin's ABI {ABI}",
          gnp.MRTSHOUSE_MIN_ABI == native_min <= ABI)
    native_alarm = "".join(re.findall(r'"([^"]*)"', header.split("ALARM =", 1)[1].split(";\n")[0]))
    check("the rule-6 sentence is the plan's in both runners",
          gnp.ALARM == ALARM and native_alarm == ALARM)
    native_table = {name: (stand or None) for name, stand in
                    re.findall(r'\{"([\w-]+)", (?:"([\w-]+)"|nullptr)\}', source)}
    check(f"the element tables are twins (python {TABLE}, native {native_table})",
          native_table == TABLE)


if __name__ == "__main__":
    _failures = []

    def _check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            _failures.append(name)

    unit_cases(_check)
    mrtshouse_load_case(PY_RUNNER, "py", _check)
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\ngst_native_plugins_test.py: all checks passed")
