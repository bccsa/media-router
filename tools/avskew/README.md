# avskew — content-based A/V skew

`avskew.py` measures the A/V skew of a captured MPEG-TS against the
recording it was made from, by matching content, not by doing PTS
arithmetic on the timing chain's own stamps. It decodes both files, finds
where each window of the capture's audio and each of its video frames sits
in the reference, and reports:

- `da`: `PTS_cap − PTS_ref` of the same audio content;
- `dv`: `PTS_cap − PTS_ref` of the same picture content;
- `skew = dv − da`. Positive: at equal PTS the video content is later than
  the audio, i.e. the video is behind (the sound leads the lips).

PTS are each file's raw 90 kHz PTS, unwrapped, so `da` and `dv` carry
whatever restamp or replay-loop offset the chain applied; only their
difference is a sync figure. Exit status 0 = skew computed, 2 = no
confident match. The method, the confidence figures it prints and its
validation are in the module docstring (`python3 avskew.py --help`).

The house-clock plan uses it for its A/V checks (chapter 5 part 11: V-P1-6,
a per-PID trim moves the skew by the trim; V-P1-15, A/V through a muxer
against a baseline) and in the later phases' gate runs.

## Files

| File | What |
|---|---|
| `avskew.py` | `measure REF CAP` (the skew) and `extract TS` (decode once, keep the features as `*.feat.json.gz`) |
| `capture_mux.sh` | Records one bus edge on a box into a file, as an extra read-only consumer |
| `shiftpts.py` | Copies a TS with the PES PTS/DTS of chosen PIDs moved by N ms: the sign-convention test |
| `tsinfo.py` | PIDs, PMT stream types, packet counts, first/last PTS and PCR of a TS (stdlib only) |

## Requirements

Python 3 with the GStreamer bindings (`gi`), and the elements the decode
uses: `tsdemux`, `aacparse`, `h264parse`/`h265parse` (gst-plugins-bad),
`avdec_aac`, `avdec_h264`/`avdec_h265` (gst-libav), `deinterlace`
(gst-plugins-good). Audio must be AAC and video H.264 or H.265. A media-router
box has all of it, and so does the dev box. `capture_mux.sh` needs the
engine's `unixfd-fanout.test-client.py`, which ships in
`/opt/media-router/plugins/unixfdbus-core/py/` (set `MR_ROOT` for another
install or a checkout). Decoding is CPU-heavy: run it under `nice -n 19` on
a box that carries streams. The reference's features are cached in
`--cache-dir` (default `/tmp/avskew-cache`); delete the captures and the
cache when done.

## Measuring a chain

1. Copy the tool to the box: `mrscp -r tools/avskew mrstation@<ip>:/tmp/`.
2. Feed the chain from a recording whose A/V you trust (a replay of a
   capture into an ingest); that recording is `REF`.
3. Record the edge to judge. `EDGE` is the connection id, as the engine
   names it, `<source module>:<output port>-<target module>:<input port>`
   (the manager's connection), or the edge socket's 6-hex suffix: the socket
   is `/tmp/mr-bus-<channel port>-<suffix>.sock`, the suffix a hash of the
   connection id that survives engine restarts while the port does not.

       mrssh <ip> 'sh /tmp/avskew/capture_mux.sh <EDGE> /tmp/avskew/mux.ts 28000000'

   28,000,000 bytes is about 25 s at 8.8 Mbit/s.
4. Measure, pinning the audio pairs when the reference carries several
   tracks with the same content (`--audio CAP:REF,...`, PIDs hex or decimal):

       mrssh <ip> 'nice -n 19 python3 /tmp/avskew/avskew.py measure \
           /data/captures/<source>.ts /tmp/avskew/mux.ts \
           --audio 0xc8:0xc9 --json /tmp/avskew/mux.json'

   The first run decodes the reference (about 1.5 min for 600 s) and caches
   it.

The skew can move between captures by more than its spread inside one, so
judge a change on two or more captures and read the per-frame p10..p90 as
well as the median. A replay
loop seam inside a capture shows as two clusters, each paired and reported.

## Checking the tool itself

`shiftpts.py` makes a capture with a known error: shift the video PIDs by
+1000 ms and `measure` must report +1000 ms; shift the audio by +300 ms and
it must report −300 ms. A capture compared with a cut of its own reference
must report 0.
