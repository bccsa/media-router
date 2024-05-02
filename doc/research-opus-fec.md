# Base pipeline 

## SrtOpusOutput
```bash 
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo buffer-time=50000 ! audioconvert ! queue ! opusenc bitrate=96000 ! mpegtsmux latency=1 ! srtserversink uri="srt://127.0.0.1:123?mode=caller&latency=1" sync=false wait-for-connection=false

GST_DEBUG=opusenc:5 gst-launch-1.0 pulsesrc device=alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.mono-fallback latency-time=5000 buffer-time=5000 ! audio/x-raw,rate=48000,format=S32LE,channels=2 ! audioconvert ! audioresample ! queue max-size-time=100000000 leaky=2 flush-on-eos=true ! opusenc bitrate=96000 audio-type=2051 bitrate-type=2 ! mpegtsmux latency=1 alignment=7 ! srtserversink uri="srt://127.0.0.1:1234?mode=listener&latency=1" sync=false wait-for-connection=false

```

## SrtOpusInput 
### !!! Need to fix, when restarting output the input gives a internal stream error on reconnection 
```bash 
GST_DEBUG=queue:5 gst-launch-1.0 srtserversrc uri="srt://127.0.0.1:1234?mode=caller&latency=1" keep-listening=true wait-for-connection=false auto-reconnect=true poll-timeout=500 ! tsdemux ignore-pcr=true latency=1 program-number=1 ! opusdec ! audioresample ! queue leaky=2 max-size-time=100000000 flush-on-eos=true ! pulsesink device=alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo sync=false buffer-time=5000 max-lateness=5000000

```