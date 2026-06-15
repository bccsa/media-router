# MPEG-TS spike scripts

Reproducible proof-of-concept scripts behind the design decisions in
`docs/mpegts-dynamic-streams-plan.md` — kept so the findings can be re-verified
on a new GStreamer version (run on the target box; exit 0 = PASS).

- `klv_spike.py` — Phase 0 gate: KLV metadata PID end-to-end
  (appsrc → mpegtsmux → tsdemux → appsink) plus the garbage matrix.
  Findings: "Phase 0 findings" section of the plan.
- `pid_routing_spike.py` — Phase 3: PID-pinned request pads + `matchPids`
  pad routing incl. duplicate-PID tee fan-out.
