# MPEG-TS spike scripts

Reproducible proof-of-concept scripts behind the design decisions in
`docs/mpegts-dynamic-streams-plan.md` — kept so the findings can be re-verified
on a new GStreamer version (run on the target box; exit 0 = PASS).

- `klv_spike.py` — Phase 0 gate: KLV metadata PID end-to-end
  (appsrc → mpegtsmux → tsdemux → appsink) plus the garbage matrix.
  Findings: "Phase 0 findings" section of the plan.
- `pid_routing_spike.py` — Phase 3: PID-pinned request pads + `matchPids`
  pad routing incl. duplicate-PID tee fan-out.
- `muxer_rig.py` (+ `rig_tap.py`, `rig-klv.json`, `rig-noklv.json`) — the
  muxer's EXACT pipeline and pad-link rules run through the real
  `gst-pipeline-runner.py`, fed by two local producers (x264 8 Mbit/s CBR video,
  AAC audio) with the coalescing egress, one consumer edge attached. Reports the
  runner's per-thread CPU, counts GstBus messages (`GST_DEBUG=GST_BUS:5`), and
  checks the output stream (buf/s, kbps, video AU/s, KLV PES/s + PTS). Env
  knobs: `MUX_PROPS` replaces the mux latency props, `KLV_PROPS` appends to the
  appsrc, `PIPE_SED='old||new'` edits the pipeline string. Regenerate the JSON
  from `dist/mpegtsMuxerPipeline.js` after a builder change. Found 2026-09-02
  that a LIVE klvsrc made mpegtsmux post a latency WARNING ~130×/s (the muxer's
  whole main-thread cost); `is-live=false` fixed it with identical output.
  Needs x264enc/avenc_aac on the dev box; not part of test:py.
