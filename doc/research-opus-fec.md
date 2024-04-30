# Base pipeline 
```bash 
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo buffer-time=50000 ! audioconvert ! queue ! opusenc bitrate=96000 ! mpegtsmux latency=1 ! srtserversink uri="srt://127.0.0.1:123?mode=caller&latency=1" sync=false wait-for-connection=false

GST_DEBUG=2 gst-launch-1.0 pulsesrc device=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo latency-time=50000 buffer-time=50000 ! audio/x-raw,rate=48000,format=S32LE,channels=2 ! audioconvert ! audioresample ! queue max-size-time=100000000 leaky=2 flush-on-eos=true ! opusenc bitrate=96000 audio-type=2051 bitrate-type=2 ! mpegtsmux latency=1 alignment=7 ! srtserversink uri="srt://127.0.0.1:1235?mode=caller&latency=1" sync=false wait-for-connection=false

```