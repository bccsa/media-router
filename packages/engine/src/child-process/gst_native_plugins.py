"""The house-clock plugin loader (plan ch. 3 WI-S0-8), twin of mr-gst-runner's native_plugins.cpp:
libgstmrtshouse.so by path (never GST_PLUGIN_PATH), once, before the parse, with an ABI check. If
it cannot be used its elements get stand-ins, or the start is refused (part 4.5 rule 6)."""
import os
import sys

import gi
gi.require_version("Gst", "1.0")
from gi.repository import GObject, Gst  # noqa: E402

# The element protocol this runner speaks; a plugin below it is refused (part 4.5 rule 4).
# Bumped with mrtshouse_abi.h; equal to native_plugins.h's.
MRTSHOUSE_MIN_ABI = 1

# Part 4.5 rule 6's alarm; the engine shows the same sentence (timingPluginAlarm.ts).
ALARM = ("Native TS module not loaded: this stream carries no house time on the bus; consumers "
         "will mis-time it until the deploy is fixed.")

# One row per plugin .so of the timing path, resolved as plugins/<plugin>/native/<tool>/<file>
# then libexec/<plugin>/<file>. `required`: a miss is the module alarm, not just a log line.
# `factories`: each element and its stand-in, None for none; a phase adds its element here.
PLUGINS = [
    {"plugin": "mpegts-core", "tool": "mrtshouse", "file": "libgstmrtshouse.so",
     "required": True, "min_abi": MRTSHOUSE_MIN_ABI,
     "factories": {"mrtsrestamp": "identity", "mrtsdemux": None, "mralignwatch": "identity"}},
]

_outcomes = []     # per row: {"version", "abi", "path"} or {"detail"}; empty until load()
stood_in = set()   # element names a stand-in took over: set_property is answered with a warning


def _log(line):
    sys.stderr.write(f"[gst-runner.py] {line}\n")
    sys.stderr.flush()


def so_paths(row):
    here = os.path.dirname(os.path.abspath(__file__))
    # {src,dist}/child-process -> packages/engine -> repo root, as the TS resolver walks it.
    plugins = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
        os.path.join(here, "..", "..", "..", "..", "plugins"))
    libexec = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
    return [os.path.join(plugins, row["plugin"], "native", row["tool"], row["file"]),
            os.path.join(libexec, row["plugin"], row["file"])]


def _plugin_abi(plugin):
    """The `abi` every element of the plugin carries (WI-S0-7); 0 for a plugin without it."""
    for f in Gst.Registry.get().get_feature_list_by_plugin(plugin.get_name()):
        if not isinstance(f, Gst.ElementFactory):
            continue
        el = f.create(None)
        if el is None:
            continue
        ps = el.find_property("abi")
        return el.get_property("abi") if ps is not None and ps.value_type == GObject.TYPE_INT else 0
    return 0


def _load_row(row):
    tried = []
    for path in so_paths(row):
        if not os.path.exists(path):
            tried.append(path)
            continue
        try:
            plugin = Gst.Plugin.load_file(path)
        except Exception as e:  # noqa: BLE001 — report it and try the next candidate
            tried.append(f"{path} ({e})")
            continue
        abi = _plugin_abi(plugin)
        if abi < row["min_abi"]:
            # Out of the registry, so nothing can instantiate its elements. No later candidate
            # is tried: its types would collide with the ones this file registered.
            Gst.Registry.get().remove_plugin(plugin)
            return {"detail": f"{row['file']} abi {abi} < {row['min_abi']}: {path}"}
        _log(f"native plugin {plugin.get_name()} {plugin.get_version()} abi {abi} from {path}")
        return {"version": plugin.get_version(), "abi": abi, "path": path}
    return {"detail": f"{row['file']} not loaded, tried {', '.join(tried)}"}


def alarm(event, detail):
    """The rule-6 event (`warning` or `error`) with its detail; the engine keys on `kind`. The
    stamper raises it too (gst_bus_stamper.load_native)."""
    return {"event": event, "kind": "timing_plugin", "message": f"{ALARM} ({detail})",
            "detail": detail}


def load(emit):
    """Load the table's plugins once per process: a log line each, or for a required row that
    misses or is below its ABI a `warning` event of kind `timing_plugin` through `emit`."""
    if _outcomes:
        return
    for row in PLUGINS:
        out = _load_row(row)
        _outcomes.append(out)
        if "detail" not in out:
            continue
        if row["required"]:
            emit(alarm("warning", out["detail"]))
        else:
            _log(f"{out['detail']} — its elements get stand-ins")


def timing_plugin():
    """The `started` event's `timingPlugin`: {version, abi, path} or None. The engine clears the
    alarm on a start that carries one."""
    out = _outcomes[0] if _outcomes else None
    return None if out is None or "detail" in out else dict(out)


def stand_in(desc, emit):
    """`desc` with stand-ins for the plugins `load` could not use, or None when it names an
    element that has none: the `error` event went through `emit` and the start stops there."""
    table = {}
    for row, out in zip(PLUGINS, _outcomes):
        if "detail" in out:
            table.update(row["factories"])
    if not table:
        return desc
    out, names, refused = rewrite(desc, table)
    if refused is not None:
        detail = next(o["detail"] for r, o in zip(PLUGINS, _outcomes) if refused in r["factories"])
        emit(alarm("error", f"{detail}; {refused} has no stand-in"))
        return None
    if out != desc:
        _log(f"native TS module not loaded, parsing with stand-ins: {out}")
    stood_in.update(names)
    return out


def refuse_live_add(req_id, desc, message):
    """`bus_input_add`'s parse failure as a `command_error` event: when `desc` names an element
    of a plugin `load` could not use, `message` gains the rule-6 alarm and the load detail, with
    `kind` and `detail`. Live adds are never stood in (B-17); the module keeps running."""
    # Every element of a plugin not loaded, as if none had a stand-in: what the parse missed.
    missing = {}
    for row, out in zip(PLUGINS, _outcomes):
        if "detail" in out:
            missing.update({name: None for name in row["factories"]})
    detail = None
    if missing:
        _, _, refused = rewrite(desc, missing)
        detail = next((o["detail"] for r, o in zip(PLUGINS, _outcomes)
                       if "detail" in o and refused in r["factories"]), None)
    evt = {"event": "command_error", "message": message}
    if detail is not None:
        evt.update(message=f"{message}; {ALARM} ({detail})", kind="timing_plugin", detail=detail)
    if req_id:
        evt["id"] = req_id
    return evt


# --- gst-launch tokens (gst/parse/parse.l, as far as finding elements needs) ---------------
# Kinds: "element" (a bare factory name), "assign" (key, value start), "other". ASCII classes,
# as the C locale's in native_plugins.cpp.

def _is_space(c):
    return c in " \t\n\v\f\r"


def _ident_start(c):
    return c.isascii() and (c.isalnum() or c == "_")


def _ident_char(c):
    return c.isascii() and (c.isalnum() or c in "_-%:")


def _mime_char(c):
    return c.isascii() and (c.isalnum() or c == "-")


def _ident_end(s, i):
    while i < len(s) and _ident_char(s[i]):
        i += 1
    return i


def _quote_end(s, i):
    """Past the quote closing the one at `i`, or None when it never closes."""
    j = i + 1
    while j < len(s):
        if s[j] == "\\":
            j += 2
            continue
        if s[j] == s[i]:
            return j + 1
        j += 1
    return None


def _value_end(s, i):
    """Past a value: a quoted string, else a run of non-space where a backslash escapes one."""
    if i < len(s) and s[i] in "\"'":
        e = _quote_end(s, i)
        if e is not None:
            return e
    while i < len(s) and not _is_space(s[i]):
        i += 2 if s[i] == "\\" and i + 1 < len(s) else 1
    return i


def _caps_end(s, i):
    """A caps filter (`type/subtype…`) at `i` runs to the next `!` outside quotes; else None."""
    j = i
    while j < len(s) and _mime_char(s[j]):
        j += 1
    if j == i or j + 1 >= len(s) or s[j] != "/" or not _mime_char(s[j + 1]):
        return None
    while j < len(s) and s[j] != "!":
        if s[j] in "\"'":
            e = _quote_end(s, j)
            j = len(s) if e is None else e
        else:
            j += 2 if s[j] == "\\" and j + 1 < len(s) else 1
    return j


def _next_token(s, i):
    """(kind, begin, end, key_end, value) of the token at `i`, which is not a space."""
    c = s[i]
    if c in "!()":
        return ("other", i, i + 1, 0, 0)
    e = _caps_end(s, i)
    if e is not None:
        return ("other", i, e, 0, 0)
    if c == ".":   # `.pad`
        return ("other", i, _ident_end(s, i + 1), 0, 0)
    if not _ident_start(c):
        return ("other", i, max(_value_end(s, i), i + 1), 0, 0)
    j = _ident_end(s, i)
    k = j
    while k < len(s) and _is_space(s[k]):
        k += 1
    if k < len(s) and s[k] == "=":   # `key=value`, spaces allowed around `=`
        v = k + 1
        while v < len(s) and _is_space(s[v]):
            v += 1
        return ("assign", i, _value_end(s, v), j, v)
    # `name.` or `name.pad` is a reference to an element, not one.
    if j < len(s) and s[j] == ".":
        return ("other", i, _ident_end(s, j + 1), 0, 0)
    return ("element", i, j, 0, 0)


def _tokenize(s):
    out = []
    i = 0
    while i < len(s):
        if _is_space(s[i]):
            i += 1
            continue
        out.append(_next_token(s, i))
        i = out[-1][2]
    return out


def _unescape(v):
    """A `name=` value as GStreamer reads it: a leading double quote and the last character off,
    then backslashes outside quotes dropped (gst_parse_unescape)."""
    if len(v) >= 2 and v[0] == '"':
        v = v[1:-1]
    out = []
    quoted = False
    i = 0
    while i < len(v):
        if v[i] == "\\" and not quoted:
            i += 1
            if i >= len(v):
                break
        elif v[i] == '"' and (not quoted or v[i - 1] != "\\"):
            quoted = not quoted
        out.append(v[i])
        i += 1
    return "".join(out)


def rewrite(s, table):
    """(description, names, refused): each `table` element (factory -> stand-in, None for none)
    becomes its stand-in with only its `name=`; tokens, so a name in quotes, caps or a `name=`
    never matches. `refused`: the first element without a stand-in (the description is None)."""
    toks = _tokenize(s)
    out = []
    names = []
    last = 0   # s before this is in `out` already
    t = 0
    while t < len(toks):
        kind, begin, end, _, _ = toks[t]
        t += 1
        factory = s[begin:end]
        if kind != "element" or factory not in table:
            continue
        if table[factory] is None:
            return None, [], factory
        out.append(s[last:begin] + table[factory])
        last = end
        # Its properties follow it; `name=` stays (with the space before it), the rest go.
        name = None
        while t < len(toks) and toks[t][0] == "assign":
            _, a_begin, a_end, key_end, value = toks[t]
            if s[a_begin:key_end] == "name":
                if name is None:
                    name = _unescape(s[value:a_end])
                out.append(s[last:a_end])
            last = a_end
            t += 1
        if name:
            names.append(name)
    out.append(s[last:])
    return "".join(out), names, None
