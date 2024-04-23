```bash
gst-launch-1.0 -e v4l2src device="/dev/video0" ! videoconvert ! queue ! x264enc tune=zerolatency ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue ! audioconvert ! audioresample ! voaacenc ! aacparse ! mpegtsmux name=mux ! queue ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=caller"

gst-launch-1.0 -e v4l2src device="/dev/video0" ! videoconvert ! queue ! x264enc tune=zerolatency ! mpegtsmux name=mux ! queue ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=caller"

gst-launch-1.0 v4l2src device=/dev/video0 ! video/mjpeg,format=YUYV,width=640,height=480,framerate=30/1 ! videoconvert ! kmssink

gst-launch-1.0 v4l2src device=/dev/video0 ! "image/jpeg,width=1920,height=1080,framerate=30/1" ! avdec_mjpeg ! "video/x-raw,format=YUY2,width=1920,height=1080,framerate=30/1"! queue ! kmssink

gst-launch-1.0 v4l2src device=/dev/video0 do-timestamp=true ! image/jpeg,width=800,height=600,framerate=30/1 ! jpegparse ! jpegdec ! fakesink

gst-launch-1.0 -v v4l2src device=/dev/video0 ! image/jpeg,framerate=30/1 ! fakesink


gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1920,height=1088 ! videoconvert ! v4l2h264enc ! 'video/x-h264,level=(string)4' ! mpegtsmux name=mux ! queue ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

https://github.com/raspberrypi/linux/issues/3974#issuecomment-791727251
gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! v4l2h264enc ! 'video/x-h264,level=(string)4.2' ! fakesink

https://github.com/raspberrypi/linux/issues/3974#issuecomment-791727251
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! x264enc speed-preset=ultrafast tune=zerolatency key-int-max=20 ! video/x-h264,stream-format=byte-stream ! mpegtsmux ! queue ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=1024000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline  ! mpegtsmux latency=10 ! queue leaky=2 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! queue leaky=2 max-size-time=1000 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=1000 ! audioconvert ! audioresample ! voaacenc ! aacparse ! \
queue leaky=2 max-size-time=1000 ! mpegtsmux latency=1 name=mux ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

# Test hardware encode (not working)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! video/x-raw,format=YUY2,colorimetry=bt709,pixel-aspect-ratio=1/1,interlace-mode=progressive ! queue leaky=2 max-size-time=20000000 ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1280,height=720 ! \
avenc_h264_omx bitrate=2048000 min-force-key-unit-interval=5000000000 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# Test hardware encode (working)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! fakesink

GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! 'video/x-raw,format=YUY2' ! queue leaky=2 max-size-time=20000000 ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1280,height=720 ! v4l2h264enc ! 'video/x-h264,level=(string)4' ! fakesink

GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! video/x-raw,format=YUY2 ! queue leaky=2 max-size-time=20000000 ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1920,height=1088 ! v4l2h264enc ! 'video/x-h264,level=(string)4' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

```

---

# Worinkg

```bash
gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1920,height=1088 ! videoconvert ! fakesink

https://github.com/raspberrypi/linux/issues/3974#issuecomment-791727251
gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! v4l2h264enc ! 'video/x-h264,level=(string)4.2' ! fakesink

https://github.com/raspberrypi/linux/issues/3974#issuecomment-791727251
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! x264enc speed-preset=ultrafast tune=zerolatency key-int-max=20 ! video/x-h264,stream-format=byte-stream ! mpegtsmux ! queue ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

# Most promising, need to get latency a bit less
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1280,height=720 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=1024000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline  ! mpegtsmux latency=1 ! queue leaky=2 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1280,height=720 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=1024000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline  ! mpegtsmux latency=1 ! queue leaky=2 max-size-time=10000 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

# added queue before video rerate
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! queue leaky=2 max-size-time=10000 ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=1024000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline  ! mpegtsmux latency=1 ! queue leaky=2 max-size-time=10000 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

# Running a 1080 50p stream
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! queue leaky=2 max-size-time=1000 ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=1024000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline  ! mpegtsmux latency=1 ! queue leaky=2 max-size-time=1000 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

# Combined audio and video src
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! queue leaky=2 max-size-time=1000 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=1024000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue ! audioconvert ! audioresample ! voaacenc ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=1000 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! queue leaky=2 max-size-time=1000 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=1000 ! audioconvert ! audioresample ! voaacenc ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=1000 ! srtserversink sync=false uri="srt://0.0.0.0:5000?latency=1&mode=listener"

# ------------------------------------------------------------- Raw video source ------------------------------------------------------------- #

# base (Broken)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! video/x-raw,format=YUY2,colorimetry=bt709,width=1280,height=720,pixel-aspect-ratio=1/1,framerate=50/1,interlace-mode=progressive ! videorate ! video/x-raw,framerate=50/1 ! queue leaky=2 max-size-time=1000 ! videoscale ! video/x-raw,width=1280,height=720 ! videoconvert ! \
openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=1000 ! audioconvert ! audioresample ! voaacenc ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=1000 ! srtserversink sync=false uri="srt://127.0.0.1:1233?latency=1&mode=listener"

# Base + audio (working)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! video/x-raw,format=YUY2,colorimetry=bt709,pixel-aspect-ratio=1/1,interlace-mode=progressive ! queue leaky=2 max-size-time=10000000 ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1280,height=720 ! \
openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=5000000000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=10000000 ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 ! srtserversink sync=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# added auido params
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1280,height=720 ! \
openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=5000000000 rate-control=off slice-mode=5 ! \
video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# ------------------------------------------------------------- Hardware encoder ------------------------------------------------------------- #
# Found working example: https://forums.raspberrypi.com/viewtopic.php?t=327974
# Woeking: needed to add repeat_sequence_header=1 to allow receiver to get right sequence (https://github.com/raspberrypi/linux/issues/4739)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=30/1 ! videoscale ! video/x-raw,width=1280,height=720 ! v4l2h264enc extra-controls="encode,video_bitrate=2048000,repeat_sequence_header=1,video_gop_size=30;" ! 'video/x-h264,level=(string)4.2,profile=baseline' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# Testing to change h264_level to be able to handel 1080@50p (CPU runs to high on 1080@50 with a bitrate of 10M)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1280,height=720 ! v4l2h264enc extra-controls="encode,video_bitrate=2048000,video_bitrate_mode=2,h264_level=13,repeat_sequence_header=1,video_gop_size=30,h264_profile=0;" ! 'video/x-h264,level=(string)4.2' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# test to get cpu ussge down (added n-threads=4 to videoscale for better cpu balance)
# narrowed the qp range (https://trac.ffmpeg.org/wiki/Encode/H.264#:~:text=The%20range%20of%20the%20CRF,sane%20range%20is%2017%E2%80%9328.) // removed again, caused that the the bitrate cant go lower that 2M, 
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=50/1 ! videoscale n-threads=4 ! video/x-raw,width=1280,height=720 ! v4l2h264enc extra-controls="encode,video_bitrate=2048000,video_bitrate_mode=0,h264_level=13,repeat_sequence_header=1,video_gop_size=30,h264_profile=0" ! 'video/x-h264,level=(string)4.2' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# test to deinterlacee (https://gstreamer.freedesktop.org/documentation/deinterlace/index.html?gi-language=c)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! deinterlace mode=1 locking=2 ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=50/1 ! videoscale n-threads=4 ! video/x-raw,width=1280,height=720 ! v4l2h264enc extra-controls="encode,video_bitrate=2048000,video_bitrate_mode=0,h264_level=13,repeat_sequence_header=1,video_gop_size=30,h264_profile=0" ! 'video/x-h264,level=(string)4.2' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# (Makes no diff)  added output-io-mode=4 to try and reduce cpu load (https://e2e.ti.com/support/processors-group/processors/f/processors-forum/1205096/tda4vm-the-performance-of-performance-v4l2h264enc)
# CPU usage diff between in output-io-mode=0(40-50%), output-io-mode=1(Not working), output-io-mode=2(45-55%), output-io-mode=3(Not working) ,output-io-mode=4(40-50%), output-io-mode=5(Not working),
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=50/1 ! videoscale n-threads=4 ! video/x-raw,width=1280,height=720 ! v4l2h264enc extra-controls="encode,video_bitrate=2048000,video_bitrate_mode=0,h264_level=13,repeat_sequence_header=1,video_gop_size=30,h264_profile=0" ! 'video/x-h264,level=(string)4.2' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# test with capture-io-mode: (Makes no diff) 
# CPU usage diff between in capture-io-mode=0(40-50%), capture-io-mode=1(Not working), capture-io-mode=2(45-55%), capture-io-mode=3(Not working) ,capture-io-mode=4(40-50%), capture-io-mode=5(Not working),
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=50/1 ! videoscale n-threads=4 ! video/x-raw,width=1280,height=720 ! v4l2h264enc capture-io-mode=4 output-io-mode=4 extra-controls="encode,video_bitrate=2048000,video_bitrate_mode=0,h264_level=13,repeat_sequence_header=1,video_gop_size=30,h264_profile=0" ! 'video/x-h264,level=(string)4.2' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://0.0.0.0:5000?mode=listener&latency=10"

# Test with high latency, (Seems like buffers pack up) (added alignment=7 to the mpegtsmux element, this is for udp streaming)
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! videorate ! video/x-raw,framerate=50/1 ! videoscale n-threads=4 ! video/x-raw,width=1280,height=720 ! v4l2h264enc extra-controls="encode,video_bitrate=2048000,video_bitrate_mode=0,h264_level=13,repeat_sequence_header=1,video_gop_size=30,h264_profile=0" ! 'video/x-h264,level=(string)4.2' ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! voaacenc bitrate=184000 ! aacparse ! \
mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! srtserversink sync=false wait-for-connection=false uri="srt://10.9.1.53:5000?mode=caller&latency=3000"

```

# Local playout 

```bash
gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! jpegdec ! videorate ! video/x-raw,framerate=50/1 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! queue ! kmssink

```

# Receiving pipline for testing 
```bash
GST_DEBUG=2 gst-launch-1.0 srtsrc uri="srt://127.0.0.1:5000?mode=caller&latency=1" ! tsdemux latency=1 ignore-pcr=true ! h264parse ! openh264dec ! queue leaky=2 max-size-time=1000 ! kmssink sync=false
```

```bash
GST_DEBUG=2 gst-launch-1.0 -v v4l2src device=/dev/video0 do-timestamp=true ! video/x-raw,format=YUY2,colorimetry=bt709,pixel-aspect-ratio=1/1,interlace-mode=progressive ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1280,height=720 ! \
openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! fakesink

GST_DEBUG=2 gst-launch-1.0 -v pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=1000 ! audioconvert ! audioresample ! voaacenc ! aacparse ! fakesink

GST_DEBUG=2 gst-launch-1.0 -v pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=1000 ! fakesink
```

## Notes 

* display video encoder option: v4l2-ctl -d 11 --list-ctrls-menu