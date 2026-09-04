# RIST bridge as native GStreamer elements

The RIST input and output modules run on two native GStreamer elements,
`mrristsrc` and `mrristsink` (`plugins/rist-core/native/mrrist`, C++ on
librist), instead of the runner driving librist through a python ctypes
binding behind an `appsrc`/`appsink`. The elements own the librist context
for the pipeline's lifetime, take the same knobs the modules always had
(rist:// URLs with per-link params, profile, recovery buffer, secret and AES
key size, NPD, stats interval) as element properties, and report librist's
stats JSON as `mrrist-stats` bus messages that the module subscribes to via
`busReports`.

## Considered Options

- **Keep the python drain, optimise it** (pull thread, `extract_dup`,
  batched reads — done first, 2026-09-03/04) — kept as far as it goes, but the
  floor is the per-packet interpreter and ctypes round trip: ~0.15 ms per
  1316-byte packet on a Pi 4 per direction, 15-20 % of a core at 12 Mbit/s
  on top of librist's own work.
- **GStreamer's own `ristsink`/`ristsrc`** — rejected: TR-06-1 Simple
  Profile only, no GRE tunnel, so no main/advanced profile and no encryption,
  which every fleet link uses.
- **A sidecar process bridging librist to the bus** (the old `ristsender` CLI
  relay) — rejected: an extra UDP hop and process per link, and the same
  per-packet copy cost moved rather than removed.

## Consequences

- The RIST modules REQUIRE the plugin: a pipeline naming `mrristsink` /
  `mrristsrc` fails at parse when `libgstmrrist.so` is missing (dev: `make
  native`; image: `make native-install` → `/usr/libexec/media-router/rist-core/`).
  The runner loads it by path (`gst_rist_native.py`), never `GST_PLUGIN_PATH`.
- The recipe DEPENDS on `librist` (headers) and RDEPENDS on it at runtime.
- The runner's `rist` config path (python binding on appsink/appsrc,
  `librist.py`) remains for any pipeline that still asks for it and as the
  reference for the element's URL/param handling; remove it once the elements
  are field-proven.
- librist is used STOCK. A "wake-on-write" librist patch (let the sender
  thread drain on its 5 ms timer instead of waking per written packet) was
  tried first and measured: once the elements and the stats-interval fix
  below were in, it was worth ~0.5 % of a Pi 4 core per direction and was
  dropped rather than carried.
- librist quirk handled in the element: `rist_stats_callback_set()` never
  sets the SENDER thread's report interval, so a sender otherwise builds and
  delivers a stats report on every loop iteration (per packet). The element
  also registers a no-op legacy `rist_sender_stats_callback_set()` (via
  `dlsym`, older headers lack it) purely to set that interval.
