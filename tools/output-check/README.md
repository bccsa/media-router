# output-check — what an output's sink and device do

Tools for the house-clock plan's Phase 4 device rounds (chapter 8 WI-P4-1, register B-160): they
record, on a box, how an output's sink and its device behave, so the outputs' designs rest on
measured behaviour rather than on what GStreamer and PipeWire are expected to do. Nothing here is
loaded by the engine. The behaviours that need no device are pinned in CI by
`packages/engine/src/child-process/gst_no_late_drop_test.py` (cases 1–5); its gate cases 6–10
(`MR_GATE=1`) run on a box and call `sink_clock_trace.py` for case 7.

## `sink_clock_trace.py` — an audio sink's clock against CLOCK_MONOTONIC

    python3 sink_clock_trace.py '<sink-desc>' <seconds> <out.jsonl> [--hole AT:MS ...] [--restart AT ...]
                                [--prefill-ms N] [--rate HZ] [--channels N]
    python3 sink_clock_trace.py --summarize <out.jsonl>

It plays `audiotestsrc is-live=true` (monotonic system clock, natural base time: content arrives at
the house rate) through a prefill queue (`min-threshold-time`, the outputs' 40 ms by default) into
the sink and writes one JSON line per 100 ms:

| Field | What |
|---|---|
| `mono_ns` | CLOCK_MONOTONIC |
| `clock_ns` | the sink's provided clock (`GstPulseSinkClock` for pulsesink, `pa_stream_get_time`) |
| `delay_ns` | the ring's delay (`gst_audio_ring_buffer_delay`), -1 while no ring is acquired; always 0 for pulsesink, which has no delay method |
| `next_sample` | the base sink's write position in the ring, in samples, -1 before the first write; written less played is the fill |

`--hole AT:MS` drops the source's buffers for MS ms from AT seconds: a hole, and an underrun once
it outlasts the ring and the prefill. `--restart AT` takes the pipeline READY → PLAYING. Each is
marked by an event line. The last line, also printed, is the summary: per stretch between events,
the clock's rate against monotonic in ppm (the first 2 s after an event left out), backward
steps, the longest stall (monotonic time with the clock flat) and the steps of more than 20 ms
between two samples. It records; it judges nothing. The device term (WI-P4-4) is designed on its
traces.

The clock is read from the sink's `provided_clock` field, which exists whatever `provide-clock`
says, so the sink runs as the outputs run it (`sync=false provide-clock=false`). The tool stops
with a line, and exit status 2, if a box's PyGObject does not give a `GstAudio.AudioClock` there.

### Taking the DEV-P4a traces

From the dev Pi:

    mrssh <box> 'mkdir -p /tmp/p4-1'
    mrscp tools/output-check/sink_clock_trace.py mrstation@<box>:/tmp/p4-1/

Then on the box, as the engine user with its runtime dir; the sink must exist (an audio-decoder's
null sink exists while its module runs):

    XDG_RUNTIME_DIR=/run/user/1001 systemd-run --user --unit=p41trace --collect \
        python3 /tmp/p4-1/sink_clock_trace.py \
        'pulsesink device=<sink> sync=false provide-clock=false processing-deadline=100000000 buffer-time=100000
         stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"' \
        3600 /tmp/p4-1/<box>-<sink>.jsonl --hole 600:300 --hole 1200:1000 --restart 1800

One hour per sink (about 36,000 lines, 3 MB): the Pi 4 test box's audio-decoder null sink linked
to HDMI audio, its KT USB output, the Pi 5 test box's USB DAC, and one null sink linked to nothing
(`pactl load-module module-null-sink sink_name=<name>`; unload it after). Copy the traces back to
`/home/mrstation/mr-captures/wf13/p4/p4-1/` and delete them on the box.

## Running the gate cases on a box (DEV-P4a)

`gst_no_late_drop_test.py` finds `sink_clock_trace.py` beside itself, so both go to one directory.
From the dev Pi:

    mrscp packages/engine/src/child-process/gst_no_late_drop_test.py tools/output-check/sink_clock_trace.py \
        mrstation@<box>:/tmp/p4-1/

Then on the box, as the engine user, the box's video-player stopped for cases 9 and 10 and started
again after. The first run also takes CI cases 1–5 on the image's own plugins (the dev Pi runs
Debian's 1.22 plugins over 1.28.2 base libraries); a case whose element or helper is absent there
skips with a line:

    XDG_RUNTIME_DIR=/run/user/1001 MR_GATE=1 MR_GATE_CASES=1,2,3,4,5,6,7,8 MR_GATE_OUT=/tmp/p4-1/out \
        python3 /tmp/p4-1/gst_no_late_drop_test.py

`MR_GATE_PULSE_SINK` names the sink to play to (default: a null sink the case loads and unloads),
`MR_GATE_SUSPEND_SINK` the one case 8 suspends, `MR_GATE_CARD` and `MR_GATE_CARD_PROFILE` the card
whose profile case 8 sets to `off` and back; case 9 needs Weston running, case 10 Weston stopped
(`MR_GATE_KMS_CONNECTOR`, `MR_GATE_REFRESH_HZ`). Each case runs in a child with a time limit and
leaves its record (`case<N>*.json`, case 6's GStreamer debug log, case 7's trace) in
`MR_GATE_OUT`. Case 6 judges only where pulsesink and the GStreamer base library are one release:
a pulsesink before 1.26 under a 1.26 or later library (the dev Pi's Debian plugin under its
`/usr/local` 1.28) writes the server's read position into the ring's old field, which 1.26
replaced by `gst_audio_ring_buffer_set_segdone`, so the base class never learns it: after a hole
the sink writes behind the server and the rest of the stream is lost. The case records that and
judges nothing. The images carry 1.28.2 throughout, so there the case judges.
