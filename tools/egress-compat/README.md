# egress-compat — third-party receivers on the egress writer

`tools/egress-compat.sh` is the house-clock plan's WI-P5-15 (chapter 9, register B-252): it proves
that receivers we do not control play what the egress writer (`mrtsegress`, B-250) puts on the
wire, through a D_e raise (a flagged backward PCR step) and a re-epoch. DEV-P5a runs it from the
dev Pi for V-P5-6 against the srt, udp raw, udp RTP and rist outputs of the Pi 4 test box. Nothing
here is loaded by the engine.

## What one run does

    box output ──► front end (gst-launch-1.0) ──► tee ─┬─► capture-N.ts ─► mrts_cli pcrcheck, hcdesc
                                                       ├─► udp 127.0.0.1:FAN+1 ─► ffmpeg -f null
                                                       ├─► udp 127.0.0.1:FAN+2 ─► cvlc (dummy output)
                                                       └─► udp 127.0.0.1:FAN+3 ─► tsdemux ! decodebin3 ! fakesink

One front end receives the egress and fans the transport stream out on loopback, so each player
gets the same bytes, the box needs no second connection, and an SRT or RIST caller has one
listener. The players are judged as demuxers and decoders; the network leg is the front end's.
The players' copy is re-sliced to 7-packet datagrams (`tsparse alignment=7`): `mrristsrc` hands
over larger buffers in a burst, and VLC truncates a datagram larger than any before it and logs
the loss as an error. The capture is kept as received. The `gst` player links two elementary
streams (A+V, as DEV-P5a's routes); one with a single stream leaves its second branch unlinked.

| `--kind` (the box's output) | Front end on the dev Pi |
|---|---|
| `srt-caller` | `srtsrc` listening on `--port` (`--latency`, 200 ms) |
| `srt-listener` | `srtsrc` calling `--host`:`--port` |
| `udp` | `udpsrc` on `--port`; `--host` a multicast group, `--iface` its interface |
| `rtp` | as `udp`, then `rtpjitterbuffer latency=200 ! rtpmp2tdepay` |
| `rist` | `mrristsrc` listening on `--port` (`--profile` 1, `--buffer` 1000 ms), in a stock `gst-launch-1.0` |
| `rist-listener` | `mrristsrc` calling `--host`:`--port` |

`EGRESS_COMPAT_SECRET`, when set, is the SRT passphrase or the RIST secret; it is never logged
(the dry run hands it to its sender runner in the pipeline string, which the runner does not log).

The players run from the start (each restarted if it exits, which counts against it); the front
end opens a new capture segment each time it restarts. At `--raise-at` and `--reepoch-at` seconds
from the run's start the tool runs `--raise-cmd` and `--reepoch-cmd` (any shell command: `mrssh`
to the box, see below) and logs when each starts and returns, with its exit code. Without a
command it prints "inject the raise now" and the operator marks the event by hand once injected:
`egress-compat.sh mark --out DIR raise`; the event's window then runs from the prompt to the mark,
and an event never marked fails the run. An event time at or past `--duration` is refused, and
the report fails an event with no line in `events.log` (`FAIL raise: never fell due`), so a run
cannot pass with an event never injected.

## The verdict

Every player line is stamped with the dev Pi's uptime. The report (`DIR/report.txt`, also printed;
`egress-compat.sh report --out DIR` judges again) reads:

- **Startup**: lines up to `--grace` (10 s) after the first data are counted, not judged (a decoder
  joining between key frames reports missing references until the next one).
- **Events**: an event's window is from 1 s before its hook to `--window` (10 s) after the hook
  returned, extended to the first data of a capture segment that starts inside it. Lines in it are
  that event's; a **glitch** is a run of them with gaps under 2 s. V-P5-6 allows one per event. The
  error lines are counted per event too: VLC logs a few over a flagged backward step past about 1 s
  (B-218 F1), and they are its glitch.
- **Outside**: any judged line outside startup and the events fails the player, so does a player
  exit or a front end losing the stream outside the events.
- **Judged lines**: ffmpeg `[error]` and `[fatal]`; VLC `<module> error:` less the dev Pi's own three
  lines (no interface module, globalhotkeys, no `h264_v4l2m2m`), as `gst_egress_pins_test.py` case 9;
  `gst-launch` `ERROR:` and `WARNING:` bus lines and `GST_DEBUG=*:1` errors.
- **Proof of play**: ffmpeg's frame count (`-progress`), the decoders `decodebin3` took to PLAYING;
  VLC reports none, so only its errors are read.
- **pcrcheck** on each segment, as V-P5-1: no unflagged PCR jump, no PES at or behind its PCR, no CC
  or CRC error; PCR intervals over 40 ms pass while they are at most 0.1 % (the 99.9th percentile).
  `--restarts N` allows, per program, N unflagged jumps and N times its ES PIDs in CC errors, and
  N times the PSI PIDs (the PAT and each PMT, which `pcrcheck` counts only in its summary) in CC
  errors, for a re-epoch done by restarting the engine, which cannot flag either. Each is a total
  (`pcrcheck` gives no per-PID count), so one PID may take all of it; each capture segment gets the
  full N. `hcdesc` lists each PMT's `MRHT` epoch and D_e, so the raise and the re-epoch are seen
  on the wire.

`RESULT PASS` needs every player, the front end and every segment to pass, both events fallen
due, none left due unmarked, and every hook command to exit 0: a hook that fails (a `stall` on
a pid gone after a restart, an `mrssh` that could not connect) injected nothing, and its event
fails the run.

Outputs in `DIR`: `report.txt`, `run.conf`, `run.log` (start, segments, first data, end),
`events.log`, `hooks.log`, `<player>.log` (stamped), `ffmpeg.progress`, `frontend.log`,
`capture-N.ts` with `.pcrcheck.jsonl` and `.hcdesc.jsonl`.

## On the dev Pi

Needs ffmpeg, cvlc, the 1.28 `gst-launch-1.0` with Debian's plugins on the path (srt, rtp, libav),
`mrts_cli` (`make -C plugins/mpegts-core/native/mrts mrts_cli`) and, for rist, `mrristsrc`
(`plugins/rist-core/native/mrrist`). A private registry keeps the user's untouched (`run` and
`dry-run` use `DIR/registry.bin` when `GST_REGISTRY` is unset):

    cd <repo>
    export GST_PLUGIN_PATH=$PWD/plugins/rist-core/native/mrrist:/usr/local/lib/aarch64-linux-gnu/gstreamer-1.0:/usr/lib/aarch64-linux-gnu/gstreamer-1.0
    export GST_REGISTRY=$HOME/.cache/egress-compat-registry.bin
    tools/egress-compat.sh selftest

### The dry run (WI-P5-15's test)

`dry-run` plays a box on the dev Pi: an upstream runner (`mr-gst-runner`, base time 0 as the
engine runs it, so the mux writes house time + 1 h like a bus producer) encodes a test pattern and
a tick to TS on loopback; a sender runner takes it through `queue ! mrtsegress ! tsparse` into the
kind's sink, with a house-clock value as the engine's. The raise hook stops the upstream runner for
1.5 s (`stall`, as on a box); the re-epoch hook sets a new `house-clock` (epoch + 1, E + 2 s) on the
running writer, as the engine does on a clock step. Defaults: 120 s, raise at 40 s, re-epoch at
80 s, the receiving port 15010. The writer and the players share four cores: run it at a load
average under 3.

    for k in srt-caller srt-listener udp rtp rist rist-listener; do
        tools/egress-compat.sh dry-run --kind $k --out /tmp/egress-compat/$k || echo "$k FAILED"
    done

Each report shows a raise of about +1.5 s (`PMT vN: … D_e`), the epoch moving from 1 to 2, at
least two flagged PCR jumps (a lateness raise under load adds one), ffmpeg and `decodebin3` clean,
and VLC's error line at the raise (F1: "ES_OUT_SET_(GROUP_)PCR is called too late", one glitch, in
every kind, the rist ones included).
Under a heavier load the writer's PCR intervals pass 40 ms more often than 0.1 % and `pcrcheck`
fails while every player passes (B-252's finding): read the report's lines, not only its result.

## DEV-P5a: V-P5-6 against the Pi 4 test box

Per output, 30 minutes with one raise and one re-epoch (the defaults: raise at 600 s, re-epoch at
1200 s). The box route is an ingest into the output through a transcoder, so the raise is a
transcoder stall. Copy the script once and find the transcoder's runner by its encoder thread:

    mrscp tools/egress-compat.sh <pi4-test-box>:/tmp/
    mrssh <pi4-test-box> 'sh /tmp/egress-compat.sh runners'      # pid and thread names per runner

Re-epoch, the engine restart route (`MR_HOUSE_CLOCK_E_OVERRIDE_NS`, test only, any E but the
current one; the module's Timing section or the journal's `house-clock E` line gives it):

    RAISE="mrssh <pi4-test-box> 'sh /tmp/egress-compat.sh stall -p <runner pid> -s 1.5'"
    REEPOCH="mrssh <pi4-test-box> 'export XDG_RUNTIME_DIR=/run/user/1001; systemctl --user set-environment MR_HOUSE_CLOCK_E_OVERRIDE_NS=<E + 2000000000> && systemctl --user restart media-router'"
    tools/egress-compat.sh run --kind srt-caller --port 9000 --raise-cmd "$RAISE" \
        --reepoch-cmd "$REEPOCH" --restarts 1 --window 30 --out /tmp/v-p5-6/srt-caller

The restart also restarts the transcoder: find its pid again before the next output's run, and
undo the override afterwards (`systemctl --user unset-environment …`, restart). The live route
(Phase 0's V6: `date -s +2s` with chronyd stopped, as root, undone at once) re-epochs without
a restart: `--restarts 0`, the default window. The others: `--kind srt-listener --host
<pi4-test-box> --port <its port>`, `--kind udp --port <dest port>` (or `--host <group> --iface
<if>`), `--kind rtp …`, `--kind rist --port <dest port>`. Copy each `DIR` to the round's data.
