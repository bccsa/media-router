#!/usr/bin/env python3
"""Tests for the house-clock plugin loader (plan ch. 3 WI-S0-8): the description rewrite of
gst_native_plugins.py, the twin tables, and `mrtshouse_load_case` against the python runner, which
native_runner_protocol_test.py runs against mr-gst-runner too: plugin present, missing, without a
stand-in, and below the runners' ABI. `mrducker_load_case` (WI-P2-10: mrducker and the keyed
gate's mrptskeep) runs here against both runners (MR_GST_RUNNER overrides the native binary).
Skips (exit 0) without GStreamer or the built plugin."""
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
NATIVE_RUNNER = os.environ.get("MR_GST_RUNNER") or os.path.join(_NATIVE, "mr-gst-runner")
_DUCKER = os.path.join(_PLUGINS, "audio-processing", "native", "mrducker")
_DUCKER_SO = os.path.join(_DUCKER, "libgstmrducker.so")

with open(os.path.join(_HOUSE, "mrtshouse_abi.h"), encoding="utf-8") as fh:
    _abi_h = fh.read()
ABI = int(re.search(r"#define MRTSHOUSE_ABI (\d+)", _abi_h).group(1))
VERSION = re.search(r'#define MRTSHOUSE_VERSION "([^"]+)"', _abi_h).group(1)
# The rule-6 sentence as plan ch. 3 part 4.5 fixes it; both runners must send exactly this.
ALARM = ("Native TS module not loaded: this stream carries no house time on the bus; consumers "
         "will mis-time it until the deploy is fixed.")
# A row not required (libgstmrducker.so) refuses its modules with this, kind native_plugin.
PLUGIN_ALARM = ("Native plugin not loaded: this module needs it and cannot run until the deploy "
                "is fixed.")
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
    # The aligner input (WI-P2-6) as a 302M fan-in and a mux route build it: identity, its name.
    ("in. ! mralignwatch name=mix_aw_c1 aligner=mix input=c1 hold-on-eos=true "
     "seed-lateness=1500000000 ! mix.sink_0", "in. ! identity name=mix_aw_c1 ! mix.sink_0",
     ["mix_aw_c1"], None),
    ('parse ! mralignwatch aligner=mux input=v max-size-bytes=5000 sparse=true name=aw_v '
     '! taginject tags="title=x" ! mux.',
     'parse ! identity name=aw_v ! taginject tags="title=x" ! mux.', ["aw_v"], None),
    ("src ! mralignwatch name=a ! mrtsdemux ! sink", None, [], "mrtsdemux"),
]

# Runs once rewritten (the dropped properties would fail on the real element).
RICH = ("audiotestsrc is-live=true ! audio/x-raw, format=S16LE, rate=48000, channels=2"
        " ! mrtsrestamp name=restamp_a desync-bytes=3 ! queue name=mrtsdemux"
        ' ! mrtsrestamp  name = "restamp_b" bogus="x ! y" ! fakesink sync=false')
# Audio is no TS, so the real restamp passes none of it: the sink must not wait to preroll.
TIMING = "audiotestsrc is-live=true ! mrtsrestamp name=restamp ! fakesink sync=false async=false"
# The aligner input posts `mralignwatch` at its first buffer and every second (WI-P2-6).
ALIGN = ("audiotestsrc is-live=true ! mralignwatch name=aw_t aligner=mix input=t1"
         " ! fakesink sync=false async=false")
FUNNEL = "audiotestsrc is-live=true ! funnel name=fin ! fakesink sync=false async=false"


def ev_is(name, **fields):
    return lambda ev: ev.get("event") == name and all(ev.get(k) == v for k, v in fields.items())


def timing_alarm(ev):
    return ev.get("kind") == "timing_plugin"


def plugin_alarm(ev):
    return ev.get("kind") == "native_plugin"


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
        # Live-added inputs have no busReports entry: the runner forwards these unsubscribed.
        r = _start(argv, _PLUGINS, empty, ALIGN)
        try:
            ev = r.wait_event(ev_is("plugin_event", channel="mralignwatch:aw_t"))
            p = (ev or {}).get("payload") or {}
            check(f"{tag} present: an mralignwatch message is forwarded as mralignwatch:aw_t "
                  f"with no busReports (got {ev})",
                  p.get("aligner") == "mix" and p.get("input") == "t1"
                  and p.get("state") in ("waiting", "present", "absent") and "pace" in p)
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
        # B-17: a live add is never stood in; its refusal names the alarm, the module runs on.
        r = _start(argv, empty, empty, FUNNEL)
        try:
            r.wait_event(ev_is("state_change", state="playing"))
            r.send({"cmd": "bus_input_add", "id": "a1", "element": "fin", "name": "fin_in_aw",
                    "description": "audiotestsrc is-live=true ! mralignwatch name=aw_live"})
            got = r.wait_event(lambda e: e.get("id") == "a1")
            want = f'bus_input_add: parse failed: no element "mralignwatch"; {ALARM} ({missing})'
            check(f"{tag} missing: a bus_input_add naming mralignwatch is a command_error with "
                  f"the rule-6 alarm and the load detail (got {got})",
                  got is not None and got.get("event") == "command_error"
                  and got.get("message") == want and got.get("kind") == "timing_plugin"
                  and got.get("detail") == missing)
            r.send({"cmd": "get_property", "id": "g1", "element": "fin", "property": "name"})
            check(f"{tag} missing: the module keeps running without that input",
                  r.wait_event(ev_is("property", id="g1")) is not None
                  and r.first(ev_is("error")) is None and r.proc.poll() is None)
            r.send({"cmd": "bus_input_add", "id": "a2", "element": "fin", "name": "fin_in_q",
                    "description": "audiotestsrc is-live=true ! nosuchelement name=q"})
            got = r.wait_event(lambda e: e.get("id") == "a2")
            check(f"{tag} missing: a parse failure naming no timing element stays plain "
                  f"(got {got})", got is not None and got.get("event") == "command_error"
                  and got.get("message") == 'bus_input_add: parse failed: no element '
                  '"nosuchelement"' and "kind" not in got)
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
                want = f'bus_input_add: parse failed: no element "mrtsrestamp"; {ALARM} ({old})'
                check(f"{tag} stale: the plugin is out of the registry, so a bus_input_add "
                      f"naming its element fails to parse, refused with the alarm (B-17) "
                      f"(got {got})",
                      got is not None and got.get("event") == "command_error"
                      and got.get("message") == want and got.get("detail") == old)
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


# --- mrducker (WI-P2-10): a row that is not required, its elements without a stand-in --------
QUAD = "audio/x-raw,format=F32LE,rate=48000,channels=4,layout=interleaved,channel-mask=(bitmask)0x0"
DUCK = (f"audiotestsrc is-live=true ! {QUAD} ! mrducker name=ducker depth=-20"
        " ! fakesink sync=false async=false")
DUCK_REPORTS = [{"element": "ducker", "structure": "mrducker"}]
# The keyed gate's shape: a 1:1 filter (`dyn`), then its PTS keeper.
KEEP = ("audiotestsrc is-live=true ! audio/x-raw,format=F32LE,channels=2 ! identity name=dyn"
        " ! mrptskeep name=keep target=dyn ! fakesink sync=false async=false")
DUCKER_LOAD_LINE = "native plugin mrducker "


def mrducker_abi():
    """MRDUCKER_ABI as mrducker_abi.h defines it."""
    with open(os.path.join(_DUCKER, "mrducker_abi.h"), encoding="utf-8") as fh:
        return int(re.search(r"#define MRDUCKER_ABI (\d+)", fh.read()).group(1))


def build_ducker_stub():
    """mrducker built at MRDUCKER_ABI 0 (`make -C mrducker stub`), or None without make."""
    try:
        done = subprocess.run(["make", "-s", "-C", _DUCKER, "stub"], capture_output=True,
                              text=True, timeout=600)
    except FileNotFoundError:
        return None
    stub = os.path.join(_DUCKER, "tests", "abi0", "libgstmrducker.so")
    if done.returncode != 0 or not os.path.exists(stub):
        raise RuntimeError(f"make stub failed: {done.stdout}{done.stderr}")
    return stub


def _start_with(argv, plugins_dir, libexec_dir, pipeline, reports=None):
    r = Runner(argv, plugins_dir, libexec_dir)
    cmd = {"cmd": "start", "pipeline": pipeline}
    if reports:
        cmd["busReports"] = reports
    r.send(cmd)
    r.wait_event(lambda e: e.get("event") in ("started", "error"))
    return r


def mrducker_load_case(argv, tag, check):
    """libgstmrducker.so through `argv`'s runner: present (the elements run, mrducker's message
    forwarded by busReports), missing (only a module naming mrducker or mrptskeep is refused,
    with PLUGIN_ALARM, never the rule-6 alarm) and below the runners' ABI. libgstmrtshouse.so is
    there throughout."""
    for so in (_SO, _DUCKER_SO):
        if not os.path.exists(so):
            print(f"SKIP {tag} mrducker-load — {so} not built (make native)")
            return
    tmp = tempfile.mkdtemp(prefix="mrducker-")
    house_only = os.path.join(tmp, "plugins")
    house = tree(house_only, "mpegts-core/native/mrtshouse/libgstmrtshouse.so", _SO)
    empty = os.path.join(tmp, "empty")
    os.makedirs(empty)
    tried = [os.path.join(house_only, "audio-processing", "native", "mrducker",
                          "libgstmrducker.so"),
             os.path.join(empty, "audio-processing", "libgstmrducker.so")]
    missing = f"libgstmrducker.so not loaded, tried {', '.join(tried)}"
    ducker_abi = mrducker_abi()
    try:
        # --- present: the load line, the element in place, its message as mrducker:ducker ----
        r = _start_with(argv, _PLUGINS, empty, DUCK, DUCK_REPORTS)
        try:
            loaded = r.log_after(DUCKER_LOAD_LINE)
            check(f"{tag} mrducker present: one load line `native plugin mrducker 1.0.0 abi "
                  f"{ducker_abi} from <plugins tree>` (got {loaded!r})",
                  loaded == f"1.0.0 abi {ducker_abi} from {_DUCKER_SO}")
            check(f"{tag} mrducker present: started, no timing_plugin event",
                  r.wait_event(ev_is("started")) is not None and r.first(timing_alarm) is None)
            check(f"{tag} mrducker present: reaches PLAYING",
                  r.wait_event(ev_is("state_change", state="playing")) is not None)
            r.send({"cmd": "get_property", "id": "g1", "element": "ducker", "property": "abi"})
            got = r.wait_event(ev_is("property", id="g1"))
            check(f"{tag} mrducker present: `ducker` is the plugin's element (abi {ducker_abi})",
                  got is not None and got.get("value") == ducker_abi)
            ev = r.wait_event(ev_is("plugin_event", channel="mrducker:ducker"), timeout=5)
            p = (ev or {}).get("payload") or {}
            check(f"{tag} mrducker present: its message is forwarded as mrducker:ducker by "
                  f"busReports (got {ev})",
                  p.get("phase") in ("idle", "attack", "hold", "release")
                  and isinstance(p.get("gain-db"), (int, float))
                  and isinstance(p.get("key-db"), (int, float)) and "running-time" in p)
            r.send({"cmd": "set_property", "id": "s1", "element": "ducker", "property": "depth",
                    "value": -6.0})
            r.send({"cmd": "get_property", "id": "g2", "element": "ducker", "property": "depth"})
            got = r.wait_event(ev_is("property", id="g2"))
            check(f"{tag} mrducker present: a live depth write lands (got {got})",
                  r.wait_event(ev_is("property_set", id="s1")) is not None
                  and got is not None and got.get("value") == -6.0)
        finally:
            r.close()
        r = _start_with(argv, _PLUGINS, empty, KEEP)
        try:
            check(f"{tag} mrptskeep present: the keyed gate's shape starts and plays",
                  r.wait_event(ev_is("started")) is not None
                  and r.wait_event(ev_is("state_change", state="playing")) is not None
                  and r.first(lambda e: e.get("event") == "error") is None)
            r.send({"cmd": "get_property", "id": "g3", "element": "keep", "property": "abi"})
            got = r.wait_event(ev_is("property", id="g3"))
            check(f"{tag} mrptskeep present: the plugin's other element (abi {ducker_abi})",
                  got is not None and got.get("value") == ducker_abi)
        finally:
            r.close()

        # --- missing: no alarm at load; a module naming either element is refused, others start
        for desc, element, reports in ((DUCK, "mrducker", DUCK_REPORTS), (KEEP, "mrptskeep", None)):
            r = _start_with(argv, house_only, empty, desc, reports)
            try:
                err = r.wait_event(lambda e: e.get("event") == "error" and plugin_alarm(e))
                detail = f"{missing}; {element} has no stand-in"
                check(f"{tag} mrducker missing: a description naming {element} is refused with "
                      f"the plugin's own text, not rule 6's (got {err})",
                      err is not None and err.get("detail") == detail
                      and err.get("message") == f"{PLUGIN_ALARM} ({detail})")
                check(f"{tag} mrducker missing: that module does not start, and no timing_plugin "
                      f"event at all (the bus's house time is fine)",
                      r.first(ev_is("started")) is None and r.first(timing_alarm) is None)
                check(f"{tag} mrducker missing: the load says what a module naming it gets",
                      any(f"{missing} — a module naming mrducker, mrptskeep is refused" in line
                          for line in r.logs))
            finally:
                r.close()
        r = _start_with(argv, house_only, empty, ALIGN)
        try:
            started = r.wait_event(ev_is("started"))
            check(f"{tag} mrducker missing: a module naming no mrducker starts, the TS module "
                  f"loaded, with no timing_plugin event at all",
                  started is not None and (started.get("timingPlugin") or {}).get("path") == house
                  and r.wait_event(ev_is("state_change", state="playing")) is not None
                  and r.first(timing_alarm) is None)
        finally:
            r.close()
        # A live add naming its element: the plugin's own text too, and the module runs on.
        r = _start_with(argv, house_only, empty, FUNNEL)
        try:
            r.wait_event(ev_is("state_change", state="playing"))
            r.send({"cmd": "bus_input_add", "id": "a1", "element": "fin", "name": "fin_in_keep",
                    "description": "audiotestsrc is-live=true ! identity name=t"
                                   " ! mrptskeep target=t"})
            got = r.wait_event(lambda e: e.get("id") == "a1")
            want = (f'bus_input_add: parse failed: no element "mrptskeep"; {PLUGIN_ALARM} '
                    f"({missing})")
            check(f"{tag} mrducker missing: a bus_input_add naming mrptskeep is a command_error "
                  f"with the plugin's own text and the load detail (got {got})",
                  got is not None and got.get("event") == "command_error"
                  and got.get("message") == want and got.get("kind") == "native_plugin"
                  and got.get("detail") == missing and r.first(ev_is("error")) is None
                  and r.proc.poll() is None)
        finally:
            r.close()

        # --- below the runners' ABI: refused even with a good copy in libexec ------------------
        stub = build_ducker_stub()
        if stub is None:
            print(f"SKIP {tag} mrducker-load ABI — no make to build the ABI-0 stub")
            return
        stale_tree = os.path.join(tmp, "stale")
        tree(stale_tree, "mpegts-core/native/mrtshouse/libgstmrtshouse.so", _SO)
        stale = tree(stale_tree, "audio-processing/native/mrducker/libgstmrducker.so", stub)
        libexec = os.path.join(tmp, "libexec")
        tree(libexec, "audio-processing/libgstmrducker.so", _DUCKER_SO)
        old = f"libgstmrducker.so abi 0 < {gnp.MRDUCKER_MIN_ABI}: {stale}"
        r = _start_with(argv, stale_tree, libexec, DUCK, DUCK_REPORTS)
        try:
            err = r.wait_event(lambda e: e.get("event") == "error" and plugin_alarm(e))
            detail = f"{old}; mrducker has no stand-in"
            check(f"{tag} mrducker stale: refused with both ABI numbers and the path (got {err})",
                  err is not None and err.get("detail") == detail
                  and err.get("message") == f"{PLUGIN_ALARM} ({detail})")
            check(f"{tag} mrducker stale: neither copy loaded",
                  r.log_after(DUCKER_LOAD_LINE) is None)
        finally:
            r.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _native_table():
    """native_plugins.cpp's rows as gst_native_plugins.py writes them, the min ABIs resolved."""
    with open(os.path.join(_NATIVE, "native_plugins.h"), encoding="utf-8") as fh:
        consts = dict(re.findall(r"constexpr int (\w+) = (\d+);", fh.read()))
    with open(os.path.join(_NATIVE, "native_plugins.cpp"), encoding="utf-8") as fh:
        body = fh.read().split("static const std::vector<Row> rows = {", 1)[1]
    body = body.split("\n    };", 1)[0]
    rows = []
    for m in re.finditer(r'\{"([\w-]+)", "([\w-]+)", "([\w.-]+)", (true|false), (\w+),\s*'
                         r'\{((?:\{"[\w-]+", (?:"[\w-]+"|nullptr)\},?\s*)+)\}\}', body):
        factories = {name: (stand or None) for name, stand in
                     re.findall(r'\{"([\w-]+)", (?:"([\w-]+)"|nullptr)\}', m.group(6))}
        rows.append({"plugin": m.group(1), "tool": m.group(2), "file": m.group(3),
                     "required": m.group(4) == "true", "min_abi": int(consts[m.group(5)]),
                     "factories": factories})
    return rows


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
    def native_const(name):
        return "".join(re.findall(r'"([^"]*)"', header.split(f" {name} =", 1)[1].split(";\n")[0]))

    check("the rule-6 sentence is the plan's in both runners",
          gnp.ALARM == ALARM and native_const("ALARM") == ALARM)
    check("a row not required refuses with one sentence and kind in both runners",
          gnp.PLUGIN_ALARM == PLUGIN_ALARM == native_const("PLUGIN_ALARM")
          and gnp.PLUGIN_KIND == native_const("PLUGIN_KIND") == "native_plugin")
    native_rows = _native_table()
    check(f"the plugin tables are twins, row for row (python {gnp.PLUGINS}, native {native_rows})",
          native_rows == gnp.PLUGINS and len(native_rows) == 2)
    check("every row's element names are its own (no element in two rows)",
          sum(len(r["factories"]) for r in gnp.PLUGINS)
          == len({n for r in gnp.PLUGINS for n in r["factories"]}))
    check("mralignwatch stands in as identity (part 4.5 rule 6)",
          TABLE.get("mralignwatch") == "identity")
    ducker_abi = mrducker_abi()
    ducker = next((r for r in gnp.PLUGINS if r["file"] == "libgstmrducker.so"), {})
    check(f"mrducker: audio-processing's row, not required, mrducker and mrptskeep without a "
          f"stand-in, its min ABI {gnp.MRDUCKER_MIN_ABI} at most the plugin's {ducker_abi} "
          f"(WI-P2-10)",
          ducker.get("plugin") == "audio-processing" and ducker.get("tool") == "mrducker"
          and ducker.get("required") is False
          and ducker.get("factories") == {"mrducker": None, "mrptskeep": None}
          and ducker.get("min_abi") == gnp.MRDUCKER_MIN_ABI <= ducker_abi)
    check("timingPlugin reports row 0, libgstmrtshouse.so, in both runners",
          gnp.PLUGINS[0]["file"] == "libgstmrtshouse.so"
          and native_rows[0]["file"] == "libgstmrtshouse.so")
    with open(os.path.join(_NATIVE, "runner.cpp"), encoding="utf-8") as fh:
        runner_cpp = fh.read()
    with open(os.path.join(_HERE, "gst-pipeline-runner.py"), encoding="utf-8") as fh:
        runner_py = fh.read()
    cpp = re.search(r"kForwardedMessages\[\] = \{([^}]*)\}", runner_cpp).group(1)
    cpp_names = ["mrlateness" if "lateness::MESSAGE" in x else x.strip().strip('"')
                 for x in cpp.split(",")]
    py_names = re.findall(r'"([\w-]+)"', re.search(
        r"FORWARDED_ELEMENT_MESSAGES = \(([^)]*)\)", runner_py).group(1))
    check(f"the unsubscribed element messages are twins (native {cpp_names}, python {py_names})",
          cpp_names == py_names == ["mrlateness", "mralignwatch", "mrtsdemux"])


if __name__ == "__main__":
    _failures = []

    def _check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            _failures.append(name)

    unit_cases(_check)
    mrtshouse_load_case(PY_RUNNER, "py", _check)
    mrducker_load_case(PY_RUNNER, "py", _check)
    if os.path.exists(NATIVE_RUNNER):
        mrducker_load_case([NATIVE_RUNNER], "native", _check)
    else:
        print(f"SKIP native mrducker-load — {NATIVE_RUNNER} not built (make native)")
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\ngst_native_plugins_test.py: all checks passed")
