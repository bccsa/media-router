`stamp_model_vectors.txt` is GENERATED — do not edit by hand. Generator:

    cd plugins/subtitle-core/py && python3 subtitle_stamp_dump.py \
        > ../../mpegts-core/native/mrpeshouse/tests/stamp_model_vectors.txt

It records every `StampModel.observe` of the python spec over the engine
test's synthetic program (real `ts_timeline` stamper); `stamp_model_test`
replays it and must match K and each house time bit for bit. Regenerate after
any change to `subtitle_stamp_model.py`, then port the change to `stamp_model.cpp`.
