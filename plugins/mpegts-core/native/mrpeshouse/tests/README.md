`stamp_model_vectors.txt` is FROZEN — do not edit by hand. Its generator,
`subtitle-core/py/subtitle_stamp_dump.py`, was retired with the anchored stamper
it ran (plan ch. 6 WI-P2-3); the whole K model goes with subtitle K recovery in
Phase 3 (WI-P3-17).

It records every `StampModel.observe` of the python spec over the engine
test's synthetic program, as the anchored stamper stamped it, through source
jumps both ways; `stamp_model_test` replays it and must match K and each house
time bit for bit. A change to `subtitle_stamp_model.py` is ported to
`stamp_model.cpp`, and `subtitle_peshouse_gst_test.py` holds the element to the
python spec on identity-stamped chunks.
