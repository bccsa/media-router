# Base pipeline

```bash
gst-launch-1.0 -v playbin3 video-sink=kmssink uri=""

GST_DEBUG=2 gst-launch-1.0 uridecodebin3 download=true use-buffering=true async-handling=true buffer-duration=100000 uri=https://url.com/toplevel.m3u8 ! kmssink

GST_DEBUG=5 gst-launch-1.0 uridecodebin3 uri=https://url.com/toplevel.m3u8! kmssink

gst-launch-1.0 -v uridecodebin3 download=true use-buffering=true async-handling=true buffer-duration=100000 caps="audio/x-raw" name=t uri="""" t. ! videoconvert ! queue ! kmssink t. ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 t. ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=2 GST_BIN_FLAG_STREAMS_AWARE=true gst-launch-1.0 -v urisourcebin uri=https://url.com/toplevel.m3u8name=src src. ! decodebin3 ! kmssink sync=false

GST_DEBUG=2 gst-launch-1.0 urisourcebin parse-streams=true uri=https://url.com/toplevel.m3u8! queue ! hlsdemux ! fakesink ! avdec_h264 ! queue ! videoconvert ! kmssink

GST_DEBUG=2 gst-launch-1.0 urisourcebin uri=https://url.com/toplevel.m3u8download=true use-buffering=true async-handling=true buffer-duration=100000 parse-streams=true ! hlsdemux2 ! fakesink

GST_DEBUG=2 gst-launch-1.0 uridecodebin3 uri=https://url.com/toplevel.m3u8name=dec dec. ! queue min-threshold-time=100000000 max-size-buffers=0 max-size-bytes=0 max-size-time=110000000 ! videoconvert ! kmssink sync=false dec. ! queue min-threshold-time=200000000 max-size-buffers=0 max-size-bytes=0 max-size-time=210000000 ! audioconvert ! pulsesink device=alsa_output.usb-KTMicro_KT_USB_Audio_2021-04-13-0000-0000-0000--00.analog-stereo sync=false

GST_DEBUG=2 gst-launch-1.0 uridecodebin3 uri=https://url.com/toplevel.m3u8name=dec dec. ! queue min-threshold-time=100000000 max-size-buffers=0 max-size-bytes=0 max-size-time=110000000 ! videoconvert ! kmssink sync=false dec. ! pulsesink device=alsa_output.usb-KTMicro_KT_USB_Audio_2021-04-13-0000-0000-0000--00.analog-stereo sync=false

GST_DEBUG=2 gst-launch-1.0 uridecodebin3 uri=https://url.com/toplevel.m3u8! audioconvert ! pulsesink device=MR_PA_HlsPlayer_7633 sync=false

GST_DEBUG=3 gst-launch-1.0 -v souphttpsrc location=https://url.com/toplevel.m3u8! hlsdemux ! pulsesink device=MR_PA_HlsPlayer_7633

GST_DEBUG=3 gst-launch-1.0 playbin3 uri=https://url.com/toplevel.m3u8video-sink=kmssink async-handling=true audio-stream-combiner=adder

GST_DEBUG=2 gst-launch-1.0 playbin3 uri=https://url.com/toplevel.m3u8name=p async-handling=true  video-sink="kmssink sync=false" audio-sink="pulsesink device=MR_PA_HlsPlayer_7633 sync=false async=false"

GST_DEBUG=2 gst-launch-1.0 uridecodebin3 download=true use-buffering=true async-handling=true buffer-duration=100000 uri=https://url.com/toplevel.m3u8name=src src. ! kmssink src. ! rawaudioparse ! audioconvert ! audioresample ! fakesink

GST_DEBUG=2 gst-launch-1.0 uridecodebin3 download=true use-buffering=true async-handling=true buffer-duration=100000 uri=https://url.com/toplevel.m3u8name=d ! kmssink d. ! audioconvert ! fakesink

GST_DEBUG=2 gst-launch-1.0 souphttpsrc do-timestamp=true location=https://url.com/toplevel.m3u8is-live=true ! hlsdemux ! uridecodebin3 ! fakesink

gst-launch-1.0 uridecodebin expose-all-streams=true uri=https://url.com/toplevel.m3u8name=bin ! queue ! kmssink

GST_DEBUG=2 gst-launch-1.0 uridecodebin expose-all-streams=true uri=https://url.com/toplevel.m3u8connection-speed=1024 name=demux demux. ! kmssink sync=false demux.audio_0 ! audiomixer name=mix ! pulsesink device=MR_PA_HlsPlayer_7633 sync=false async=false slave-method=0

GST_DEBUG=2 gst-launch-1.0 uridecodebin uri=https://url.com/toplevel.m3u8expose-all-streams=true connection-speed=1024 name=dec dec. ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 max-size-time=100000000 ! kmssink sync=false dec.audio_0 ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 max-size-time=100000000 ! audiomixer name=mix ! pulsesink device=MR_PA_HlsPlayer_7633 sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=2 gst-launch-1.0 uridecodebin connection-speed=1024 uri=https://url.com/toplevel.m3u8name=d ! kmssink d. ! audioconvert ! deinterleave ! interleave name=mix ! pulsesink device="MR_PA_HlsPlayer_7633" sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 d. ! audioconvert ! mix. d. ! audioconvert ! mix.    d. ! audioconvert ! mix. d. ! audioconvert ! mix.

# Working
GST_DEBUG=2 gst-launch-1.0 uridecodebin connection-speed=8192 uri=https://url.com/toplevel.m3u8name=d ! kmssink d. ! audioconvert ! interleave name=mix ! pulsesink device="MR_PA_HlsPlayer_7633" sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 d. ! audioconvert ! mix. d. ! audioconvert ! mix.    d. ! audioconvert ! mix. d. ! audioconvert ! mix.

GST_DEBUG=2 gst-launch-1.0 uridecodebin connection-speed=4192 uri="""" name=d ! queue ! kmssink audiointerleave name=mix ! queue ! pulsesink device="MR_PA_HlsPlayer_7633" sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 d. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=dia dia.src_0 ! audioconvert ! mix.sink_0 dia.src_1 ! audioconvert ! mix.sink_1 d. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=dib dib.src_0 ! audioconvert ! mix.sink_2 dib.src_1 ! audioconvert ! mix.sink_3 d. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=dic dic.src_0 ! audioconvert ! mix.sink_4 dic.src_1 ! audioconvert ! mix.sink_5

# test to split stereo channels into mono streams
GST_DEBUG=2 gst-launch-1.0 uridecodebin connection-speed=8192 uri=https://url.com/toplevel.m3u8name=d ! kmssink interleave name=mix ! pulsesink device="MR_PA_HlsPlayer_7633" sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 d. ! audioconvert ! deinterleave name=a a. ! audioconvert ! mix. d. ! audioconvert ! mix.

GST_DEBUG=2 gst-launch-1.0 uridecodebin uri=https://url.com/toplevel.m3u8connection-speed=4096 name=bin ! videoconvert ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 ! kmssink sync=false audiointerleave name=mix ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 ! pulsesink device=MR_PA_HlsPlayer_7633 sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 bin. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=di1 di1.src_0 ! audioconvert ! mix.sink_0 di1.src_1 ! audioconvert ! mix.sink_1 bin. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=di2 di2.src_0 ! audioconvert ! mix.sink_2 di2.src_1 ! audioconvert ! mix.sink_3 bin. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=di3 di3.src_0 ! audioconvert ! mix.sink_4 di3.src_1 ! audioconvert ! mix.sink_5

GST_DEBUG=2 gst-launch-1.0 uridecodebin uri=https://url.com/toplevel.m3u8connection-speed=4096 name=bin ! videoconvert ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 ! kmssink sync=false audiointerleave name=mix ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 ! pulsesink device=MR_PA_HlsPlayer_7633 sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 bin. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=di1 di1.src_0 ! audioconvert ! mix.sink_0 di1.src_1 ! audioconvert ! mix.sink_1 bin. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=di2 di2.src_0 ! audioconvert ! mix.sink_2 di2.src_1 ! audioconvert ! mix.sink_3 bin. ! audioconvert ! "audio/x-raw,channels=2" ! deinterleave name=di3 di3.src_0 ! audioconvert ! mix.sink_4 di3.src_1 ! audioconvert ! mix.sink_5

# test pulse src with multi channele (Fixed, need to figure out the bit mask is working )
GST_DEBUG=2 gst-launch-1.0 -v pulsesrc device=MR_PA_HlsPlayer_7633.monitor ! 'audio/x-raw,rate=48000,format=S16LE,channels=2,channel-mask=(bitmask)0x3' ! fakesink

# load Loopback with channel maps
pactl load-module module-loopback  source=MR_PA_HlsPlayer_7633.monitor sink=MR_PA_SrtOpusOutput_7352-remap latency_msec=50 channels=2 rate=48000 format=s24le source_dont_move=true sink_dont_move=true

pactl load-module module-loopback  source=MR_PA_HlsPlayer_7633.monitor sink=MR_PA_SrtOpusOutput_7352 latency_msec=50 channels=2 rate=48000 format=s24le channel_map=aux2,aux3

pw-cli create-node adapter factory.name=libpipewire-module-loopback node.name=MR_PA_SrtOpusOutput_7352-remap node.description="Loopback Device" capture.props={ media.class="Audio/Sink" audio.position=[ FL FR ] } playback.props={ audio.position=[ AUX2 AUX3 ] node.target="MR_PA_HlsPlayer_7633.monitor" stream.dont-remix=true node.passive=true }


pactl load-module module-remap-sink sink_name=MR_PA_SrtOpusOutput_7352-remap master=MR_PA_SrtOpusOutput_7352 channels=2 rate=48000 format=s24le master_channel_map=front-left,front-right channel_map=aux2,aux3

master_channel_map=aux0,aux1,aux2,aux3,aux4,aux5,aux6,aux7 channel_map=aux0,aux1,aux2,aux3,aux4,aux5,aux6,aux7

pactl load-module module-null-sink sink_name=MR_PA_HlsPlayer_test format=s16le rate=48000 channels=6 channel_map=aux0,aux1,aux2,aux3,aux4,aux5

GST_DEBUG=2 gst-launch-1.0 -v uridecodebin uri="""" connection-speed=4096 name=bin ! videoconvert ! queue ! kmssink sync=false audiointerleave name=mix ! queue min-threshold-time=0 max-size-buffers=0 max-size-bytes=0 ! pulsesink device=MR_PA_HlsPlayer_7633 sync=false async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 bin. ! audioconvert ! audio/x-raw,channels=2 ! deinterleave name=di1 di1.src_0 ! audioconvert ! mix.sink_0 di1.src_1 ! audioconvert ! mix.sink_1 bin. ! audioconvert ! audio/x-raw,channels=2 ! deinterleave name=di2 di2.src_0 ! audioconvert ! mix.sink_2 di2.src_1 ! audioconvert ! mix.sink_3 bin. ! audioconvert ! audio/x-raw,channels=2 ! deinterleave name=di3 di3.src_0 ! audioconvert ! mix.sink_4 di3.src_1 ! audioconvert ! mix.sink_5 bin. ! audioconvert ! audio/x-raw,channels=2 ! deinterleave name=di4 di4.src_0 ! audioconvert ! mix.sink_6 di4.src_1 ! audioconvert ! mix.sink_7


pw-loopback --name=nnasa --channels=8 -channel-map='[aux0, aux1, aux2, aux3, aux4, aux5, aux6, aux7]' --capture=149 --capture-props='media.class=Audio/Sink audio.position=[aux2, aux3] stream.capture.sink=true' --playback=168 --playback-props='media.class=Audio/Source audio.position=[FL, FR]'

pw-loopback --name=nnasa --channels=8 -m '[aux0 aux1 aux2 aux3 aux4 aux5 aux6 aux7]' --capture-props='audio.position=[aux2] stream.dont-remix=true stream.capture.sink=true' --capture=149 --playback-props='audio.position=[MONO]' --playback=168

pactl load-module module-remap-sink sink_name=MR_PA_SrtOpusOutput_7352-remap master=MR_PA_SrtOpusOutput_7352 master_channel_map=front-left,front-right channel_map=aux2,aux3

# Working, but need to fix vu meters, and had to add a channel map to the null sink
pactl load-module module-loopback  source=MR_PA_HlsPlayer_7633.monitor sink=MR_PA_SrtOpusOutput_7352 latency_msec=50 channel_map='aux3,aux4' sink_input_properties='audio.position=[aux0,aux1]'

GST_DEBUG=2 gst-launch-1.0 -v pulsesrc device=MR_PA_HlsPlayer_7633.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=6 ! level peak-falloff=120 peak-ttl=50000000 interval=100000000 ! fakesink silent=true

pactl load-module module-remap-sink sink_name=MR_PA_HlsPlayer_7633-remap master=MR_PA_HlsPlayer_7633 master_channel_map=aux0,aux1,aux2,aux3,aux4,aux5,aux6,aux7 channel_map=aux0,aux1,aux2,aux3,aux4,aux5,aux6,aux7 channels=8

GST_DEBUG=2 gst-launch-1.0 uridecodebin download=true use-buffering=true async-handling=true buffer-duration=100000 uri="""" connection-speed=10000 name=bin ! videoconvert ! kmssink sync=false  bin. ! audioconvert ! audio/x-raw,channels=2 ! pulsesink device=HlsPlayer_7633_sink_0 sync=false async=false slave-method=0 bin. ! audioconvert ! audio/x-raw,channels=2 ! pulsesink device=HlsPlayer_7633_sink_1 sync=false async=false slave-method=0

GST_DEBUG=2 gst-launch-1.0 urisourcebin uri="""" ! fakesink

GST_DEBUG=2 gst-launch-1.0 souphttpsrc location="""" ! hlsdemux2 ! fakesink


## link used: https://stackoverflow.com/questions/25201109/gstreamer-recording-m3u8-stream
# working pipeline, need to find a way to detect which src is what language
GST_DEBUG=2 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8! hlsdemux connection-speed=4096 name=demux demux. ! decodebin3 ! videoconvert ! kmssink sync=true demux.src_1 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink device=HlsPlayer_7633_sink_0 sync=true async=false slave-method=0 demux.src_2 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink device=HlsPlayer_7633_sink_1 sync=true async=false slave-method=0

GST_DEBUG=2 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8 ! hlsdemux connection-speed=4096 name=demux demux. ! decodebin3 ! videoconvert ! queue ! kmssink sync=true ts-offset=1000000000  demux.src_1 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=HlsPlayer_7633_sink_0 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_2 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=HlsPlayer_7633_sink_1 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=srtserversink:5 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=false location=https://url.com/toplevel.m3u8 ! hlsdemux async-handling=true connection-speed=4096 name=demux demux. ! srtserversink name="srtserversink" wait-for-connection=true sync=false async=false uri="srt://0.0.0.0:1234?mode=listener&latency=10" demux.src_1 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_mul sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_2 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_4 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_nya sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

# test with abr (ABR is not working, pipeline crash on bitrate change)
GST_DEBUG=2 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8! hlsdemux async-handling=true name=demux demux. ! decodebin3 ! videoconvert ! kmssink sync=true async=true demux.src_1 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink device=HlsPlayer_7633_sink_0 sync=true async=true slave-method=0 demux.src_2 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink device=HlsPlayer_7633_sink_1 sync=true async=true slave-method=0

# Test to repackage ts to keep sync
GST_DEBUG=2 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8 ! hlsdemux async-handling=true name=demux demux.src_0 ! tsdemux ! h264parse ! mpegtsmux name=mux alignment=7 ! srtserversink name="srtserversink" wait-for-connection=true sync=true async=false uri="srt://0.0.0.0:1234?mode=listener&latency=10" demux.src_1 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_mul sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=2 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8 ! hlsdemux connection-speed=4096 name=demux demux. ! tsdemux ! h264parse ! mpegtsmux alignment=7 name=mux ! srtserversink name="srtserversink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:1234?mode=listener&latency=10" demux.src_1 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_mul sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_2 ! tee name=tee ! aacparse ! mux.

GST_DEBUG=2 gst-launch-1.0 souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8 ! hlsdemux connection-speed=4096 name=demux demux.src_0 ! parsebin ! mpegtsmux alignment=7 name=mux ! srtserversink name="srtserversink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:1234?mode=listener&latency=10" demux.src_1 ! tee name=tee ! queue ! parsebin ! mux. tee. ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_2 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_deu sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_3 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_4 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux.src_5 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_spa sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000



GST_DEBUG=2 gst-launch-1.0 -v souphttpsrc is-live=true keep-alive=true do-timestamp=true location="https://url.com/toplevel.m3u8" ! parsebin name=demux demux.src_0 ! queue !  decodebin3 ! videoconvert ! queue ! kmssink

GST_DEBUG=2 gst-launch-1.0 -v playbin3 connection-speed=4096 video-sink=kmssink uri="https://url.com/toplevel.m3u8" audio-stream-combiner="interleave"

GST_DEBUG=2 gst-launch-1.0 -v playbin3 uri="file:///home/mrstation/media-router/doc/index.m3u8" !  decodebin3 ! videoconvert ! queue ! kmssink

GST_DEBUG=2 gst-launch-1.0 -v ./index.m3u8 ! parsebin connection-speed=10 name=demux demux.src_0 ! queue !  decodebin3 ! videoconvert ! queue ! kmssink

gst-launch-1.0 -v souphttpsrc is-live=true keep-alive=true do-timestamp=true location="" ! parsebin connection-speed=2048 async-handling=true name=s s. ! decodebin3 caps="text/x-raw" ! autovideosink

gst-launch-1.0 souphttpsrc location="" ! parsebin ! autovideosink

gst-launch-1.0 uridecodebin3 uri="file:///home/mrstation/media-router/doc/index.m3u8" ! videoconvert ! kmssink

gst-launch-1.0 -v souphttpsrc is-live=true keep-alive=true do-timestamp=true location="" ! hlsdemux message-forward=true connection-speed=2048 ! qtdemux ! h264parse ! v4l2h264dec ! queue ! videoscale ! videoconvert ! kmssink

gst-launch-1.0 -v urisourcebin uri="file:///home/mrstation/media-router/doc/index.m3u8" ! decodebin3 ! queue ! videoconvert ! kmssink

gst-launch-1.0 -v souphttpsrc is-live=true keep-alive=true do-timestamp=true location="" ! parsebin connection-speed=2048 ! decodebin3 async-handling=true name=s s. ! kmssink


gst-launch-1.0 -v urisourcebin uri=https://url.com/toplevel.m3u8 connection-speed=10 name=so so.src_2 ! parsebin async-handling=true expose-all-streams=true name=demux demux. ! decodebin3 ! queue ! kmssink


## working by adding multiqueue and parsebin  name=demux demux.src_2
GST_DEBUG=0 gst-launch-1.0 -v souphttpsrc is-live=true keep-alive=true do-timestamp=true location=https://url.com/toplevel.m3u8 ! multiqueue name=q q. ! parsebin expose-all-streams=true connection-speed=1024 name=demux demux.src_2 ! decodebin3 ! queue ! kmssink demux.src_0 ! queue ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

gst-launch-1.0 -v urisourcebin parse-streams=false uri=https://url.com/toplevel.m3u8 connection-speed=10 name=so so.src_2 ! decodebin3 ! queue ! kmssink so.src_0 ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000


GST_DEBUG=0 gst-launch-1.0 -v https://url.com/toplevel.m3u8 ! parsebin connection-speed=1024 sink-caps=application/x-hls ! decodebin3 ! queue ! kmssink

## working by adding multiqueue and parsebin  name=demux demux.src_2
GST_DEBUG=0 gst-launch-1.0 -v souphttpsrc is-live=true keep-alive=true do-timestamp=true name=souphttpsrc location=https://url.com/toplevel.m3u8 souphttpsrc. ! parsebin expose-all-streams=true connection-speed=1024 name=demux demux.src_2 ! decodebin3 ! queue ! kmssink

```

To add an `audio-stream-combiner` (also known as `audiomixer` in GStreamer) to your pipeline to combine all stereo audio streams into a multi-channel output, you can explicitly connect the different elements in the pipeline. Since `playbin3` manages the playback internally, we need to branch the pipeline appropriately and add the `audiomixer` or similar element after demuxing the audio.

Here is an outline of how the GStreamer pipeline can be constructed to fit this requirement:

1. Use `uridecodebin3` to handle the HLS input and demuxing.
2. Extract the audio streams with `decodebin`.
3. Use an `audiomixer` to combine the stereo streams into a multi-channel output.
4. Link the combined output to the audio sink (`pulsesink`).

Note that creating this pipeline involves manually constructing and linking elements. Here's how you can modify your command to fit this setup using `gst-launch-1.0`:

```bash
GST_DEBUG=2 gst-launch-1.0 uridecodebin uri=https://url.com/toplevel.m3u8name=demux demux. ! kmssink demux. ! pulsesink device=MR_PA_HlsPlayer_639 sync=false async=false \
queue ! audioconvert ! audioresample ! audiomixer name=amixer ! audioconvert ! \
audioresample ! pulsesink device=MR_PA_HlsPlayer_639 sync=false async=false \
demux. ! queue ! kmssink
demux. ! queue ! decodebin ! audioconvert ! audioresample ! amixer. \
demux. ! queue ! decodebin ! audioconvert ! audioresample ! amixer.
```

### Explanation

1. **uridecodebin3**: `uridecodebin3` is used to handle the HLS stream. It demultiplexes the streams and outputs separate audio and video pads.

2. **queue**: Ensures that the pipeline does not block and can handle different stream types in parallel.

3. **decodebin**: This element decodes the audio streams.

4. **audioconvert and audioresample**: These elements ensure the audio streams are in a suitable format and rate for mixing.

5. **audiomixer**: Combines all the stereo streams into a multi-channel output.

6. **pulsesink**: Sends the mixed audio to the specified PulseAudio sink.

To handle multiple audio streams, multiple branches and queues are included. You need to link each audio stream to the `audiomixer`.

Note: The command assumes you will have multiple audio streams in the HLS manifest. If there is a different number of streams, you may need to add or remove `demux. ! queue ! decodebin ! audioconvert ! audioresample ! amixer.` parts accordingly.

Feel free to test and adjust based on the actual number of audio streams and the specifics of your HLS content.

https://url.com/toplevel.m3u8

https://url.com/toplevel.m3u8

# Streamlink

```bash
streamlink  --stdout "https://url.com/toplevel.m3u8" best | gst-launch-1.0 -v fdsrc ! decodebin3 ! kmssink

GST_DEBUG=2 gst-launch-1.0 -v filesrc name=fsrc location=<(streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8X" best -O) fsrc. ! tsdemux name=demux demux. ! decodebin ! queue !  kmssink demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_8862_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_8862_sink_deu sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=2 gst-launch-1.0 -v filesrc location=<(streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O) ! tsdemux name=demux demux. ! decodebin ! videoconvert ! queue ! kmssink ts-offset=0 sync=true  demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=2 gst-launch-1.0 -v filesrc location=<(streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O) ! tsdemux name=demux demux. ! decodebin ! videoconvert ! queue ! kmssink ts-offset=0 sync=true  demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8X" best -O | GST_DEBUG=2 gst-launch-1.0 -v filesrc location="/dev/stdin" ! tsdemux name=demux demux. ! decodebin ! videoconvert ! queue ! kmssink ts-offset=0 sync=true  demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O | GST_DEBUG=2 gst-launch-1.0 -v filesrc location="/dev/stdin" ! tsparse ! tsdemux name=mux mux. ! decodebin ! queue !  kmssink mux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 mux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O | GST_DEBUG=2 node /home/mrstation/media-router/server/child_processes/SrtGstGeneric_child.js 'filesrc location="/dev/stdin" ! tsdemux name=demux demux. ! mpegtsmux alignment=7 name=mux ! queue ! srtserversink name="srtserversink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:5000?mode=listener&latency=10" demux. ! tee name=tee ! queue ! parsebin ! mux. tee. ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000'

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O | node /home/mrstation/media-router/server/child_processes/SrtGstGeneric_child.js 'filesrc location="/dev/stdin" ! tsdemux name=demux demux. ! h264parse ! queue ! mpegtsmux alignment=7 name=mux ! queue ! srtserversink name="srtserversink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:5000?mode=listener&latency=10" demux. ! tee name=tee ! queue ! parsebin ! mux. tee. ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000'

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O | node /home/mrstation/media-router/server/child_processes/SrtGstGeneric_child.js 'filesrc location="/dev/stdin" ! tsdemux name=demux demux. ! queue ! mpegtsmux alignment=7 name=mux ! queue ! srtserversink name="srtserversink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:5000?mode=listener&latency=10" demux. ! tee name=tee ! queue ! parsebin ! mux. tee. ! decodebin3 ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000'

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" best -O | GST_DEBUG=2 gst-launch-1.0 -v filesrc location="/dev/stdin" ! tsparse ! tsdemux name=mux mux. ! decodebin ! queue !  kmssink mux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_8862_sink_deu sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 mux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_8862_sink_eng sync=true async=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u88" 450p -O | node /home/mrstation/media-router/server/child_processes/SrtGstGeneric_child.js 'filesrc location="/dev/stdin" ! tsdemux  ignore-pcr=true name=demux demux. ! decodebin ! videoconvert ! queue ! kmssink ts-offset=4000000000 sync=true  demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=4000000000 device=MR_PA_HlsPlayer_7633 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000'

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "nor,eng,fra" --hls-live-restart "https://url.com/toplevel.m3u8" 1080p -O | node /home/mrstation/media-router/server/child_processes/SrtGstGeneric_child.js 'filesrc location="/dev/stdin" ! tsdemux name=demux demux. ! decodebin ! videoconvert ! queue ! kmssink ts-offset=0 sync=true  demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink ts-offset=0 device=MR_PA_HlsPlayer_7633 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_eng sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_7633_sink_fra sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000'

streamlink --ringbuffer-size 64M --player-continuous-http --player-no-close --hls-audio-select "mul,eng,fra" --hls-live-restart "" 720p -O | GST_DEBUG=2 node /home/mrstation/media-router/server/child_processes/SrtGstGeneric_child.js 'filesrc location="/dev/stdin" ! tsdemux name=demux demux. ! decodebin ! videoconvert ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 ! kmssink ts-offset=2000000000 sync=true  demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 ! pulsesink device=MR_PA_HlsPlayer_4172 ts-offset=2000000000 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_4172_sink_eng sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000 demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=HlsPlayer_4172_sink_fra sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000'

```

# FFMPEG

```bash

gst-launch-1.0 filesrc location=<(ffmpeg -i "https://url.com/toplevel.m3u8X"  -t 10  -c copy -f mpegts -) ! decodebin3 ! kmssink


ffmpeg -i "https://url.com/toplevel.m3u8X"  -t 30  -vcodec rawvideo -f mpegts - | ffplay -f mpegts -

ffmpeg -i  "https://url.com/toplevel.m3u8X" -t 3000 -f mpegts - | ffplay -i "https://url.com/toplevel.m3u8X"

```

# Test with self build streamer

```bash
node hls.js "https://stream.cdn.bcc.africa/toplevelmanifest.m3u8" eng,fra | GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/videoPipe" ! tsparse ! tsdemux name=demux demux. ! decodebin ! videoconvert ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! kmssink sync=false async=false demux. ! decodebin ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! fakesink

node hls.js "https://stream.cdn.bcc.africa/toplevelmanifest.m3u8" eng,fra


GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/videoPipe" ! tsparse ! tsdemux name=demux ! decodebin ! videoconvert ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! kmssink sync=true filesrc location="/tmp/eng_audioPipe" ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue flush-on-eos=true  ! fakesink sync=true

GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/eng_audioPipe" ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! queue flush-on-eos=true  ! fakesink sync=false async=false

GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/videoPipe" ! queue max-size-bytes=10000000 ! parsebin ! decodebin3 ! queue max-size-bytes=40000000 ! videoconvert ! kmssink sync=true

perl -le 'require "sys/ioctl.ph"; \
ioctl(STDIN, &FIONREAD, $n) or die$!; \
print unpack "L", $n' <> /tmp/videoPipe

node index.js "" nor  & sleep 3 && GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/videoPipe" ! queue max-size-bytes=10000000 ! parsebin ! decodebin3 ! queue max-size-bytes=40000000 ! kmssink sync=true  filesrc location="/tmp/nor_audioPipe" ! queue max-size-bytes=10000000 ! parsebin ! decodebin3 ! queue max-size-bytes=40000000 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink name=audioSink ts-offset=0 device=MR_PA_HlsPlayer_7783 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

node index.js "" nor  & sleep 3 && GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/nor_audioPipe" ! queue max-size-bytes=10000000 ! parsebin ! decodebin3 ! audioconvert ! queue max-size-bytes=40000000 ! pulsesink name=audioSink ts-offset=0 device=MR_PA_HlsPlayer_7783 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=3 gst-launch-1.0 filesrc location="/tmp/videoPipe" ! queue max-size-bytes=10000000 ! parsebin !  mpegtsmux alignment=7 name=mux ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! srtserversink name="videoSink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:1234?mode=listener&latency=10"  filesrc location="/tmp/nor_audioPipe" ! queue max-size-bytes=10000000 ! parsebin ! tee name=tee ! queue ! mux. tee. ! decodebin3 ! queue max-size-bytes=40000000 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink name=audioSink ts-offset=0 device=MR_PA_HlsPlayer_7783 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

filesrc location="/tmp/videoPipe" ! queue max-size-bytes=10000000 ! parsebin !  mpegtsmux alignment=7 name=mux ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! srtserversink name="videoSink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:1234?mode=listener&latency=10"  filesrc location="/tmp/nor_audioPipe" ! queue max-size-bytes=10000000 ! parsebin ! tee name=tee ! queue ! mux. tee. ! decodebin3 ! queue max-size-bytes=40000000 ! audioconvert ! audio/x-raw,channels=2 ! pulsesink name=audioSink ts-offset=0 device=MR_PA_HlsPlayer_7783 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

filesrc location="/tmp/videoPipe" ! queue max-size-bytes=10000000 ! parsebin !  mpegtsmux alignment=7 name=mux ! queue ! srtserversink name="videoSink" wait-for-connection=false sync=true ts-offset=0 uri="srt://0.0.0.0:1234?mode=listener&latency=10"  filesrc location="/tmp/nor_audioPipe" ! queue max-size-bytes=10000000 ! parsebin ! tee name=tee ! queue ! mux. tee. ! decodebin3 ! max-size-bytes=40000000  ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink name=audioSink ts-offset=0 device=MR_PA_HlsPlayer_7783 sync=true slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000
```
