# Base

```bash
GST_DEBUG=2 gst-launch-1.0 srtserversrc uri="srt://srt.stephanopark.co.za:2000?streamid=play/scc/eng&latency=50" ! tsdemux ignore-pcr=true latency=1 name=t t. ! h264parse ! v4l2h264dec ! queue flush-on-eos=true leaky=2 max-size-time=15000000 ! kmssink sync=false async=false t. ! aacparse ! avdec_aac ! audioconvert ! queue flush-on-eos=true leaky=2 max-size-time=15000000 ! pulsesink device=alsa_output.platform-bcm2835_audio.stereo-fallback  sync=false async=false
```