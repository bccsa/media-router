# SRC

```bash
GST_DEBUG=3 gst-launch-1.0 srtsrc uri="srt://127.0.0.1:1234?mode=caller&latency=40" wait-for-connection=false ! tsparse ! rtpmp2tpay ! ristsink bonding-addresses="10.9.254.254:5004,10.9.1.158:5006" sender-buffer=20
```

# SINK

```bash
GST_DEBUG=3 gst-launch-1.0 ristsrc bonding-addresses="0.0.0.0:5004,0.0.0.0:5006" receiver-buffer=20 ! rtpmp2tdepay ! srtserversink sync=true wait-for-connection=false uri="srt://0.0.0.0:1235?mode=listener&latency=10"
```

# SRT Relay

```bash
GST_DEBUG=3 gst-launch-1.0 srtsrc uri="srt://10.9.1.192:1234?mode=caller&latency=10" wait-for-connection=false ! queue leaky=2 max-size-time=200000000 flush-on-eos=true ! srtserversink sync=true wait-for-connection=false uri="srt://0.0.0.0:1235?mode=listener&latency=10"
```

# BADNET

```bash
GST_DEBUG=3 gst-launch-1.0 videotestsrc pattern=smpte motion=wavy ! video/x-raw,width=1280,height=720 ! openh264enc multi-thread=4 bitrate=4000000 min-force-key-unit-interval=5000000000 rate-control=off slice-mode=5 ! video/x-h264,profile=baseline ! queue ! mpegtsmux ! rtpmp2tpay ! ristsink bonding-addresses="10.9.254.254:5004,10.9.1.158:5006" sender-buffer=20
```

# FFMPEG

## Sender

### udp

```bash
ffmpeg -fflags nobuffer -i "srt://127.0.0.1:3236?mode=caller&latency=10" -c:s copy -c:v copy -c:a copy -f mpegts -muxdelay 0 -max_delay 0 udp://127.0.0.1:5001
```

### rist

```bash
ristsender --buffer 300 -i udp://127.0.0.1:5001 -o "rist://10.9.1.103:5000?cname=SENDER01&buffer-min=50&buffer-max=400&rtt-min=40&rtt-max=350&reorder-buffer=1000&weight=20,rist://10.9.254.254:5004?cname=SENDER02&buffer-min=50&buffer-max=400&rtt-min=40&rtt-max=350&reorder-buffer=400&weight=1"
```

### rist flipped

```bash
ristsender --buffer 300 -i udp://127.0.0.1:5001 -o "rist://@[::]:5000?cname=SENDER01&buffer-min=50&buffer-max=400&rtt-min=40&rtt-max=350&reorder-buffer=1000&weight=20,rist://@[::]:5004?cname=SENDER02&buffer-min=50&buffer-max=400&rtt-min=40&rtt-max=350&reorder-buffer=400&weight=1"
```

## Receiver

### udp

```bash
ffmpeg -fflags nobuffer -i udp://127.0.0.1:5001  -c:s copy -c:v copy -c:a copy -f mpegts -muxdelay 0 -max_delay 0 "srt://127.0.0.1:4000?mode=caller&latency=10"
```

### rist

```bash
ristreceiver --buffer 300 -i "rist://@[::]:5000?cname=RECEIVER01&buffer-min=50&buffer-max=200&rtt-min=40&rtt-max=200&reorder-buffer=100,rist://@[::]:5004?cname=RECEIVER02&buffer-min=50&buffer-max=200&rtt-min=40&rtt-max=200&reorder-buffer=100" -o udp://127.0.0.1:5001
```

### rist flipped

```bash
ristreceiver --buffer 300 -i "rist://10.9.1.183:5000?cname=RECEIVER01&buffer-min=50&buffer-max=200&rtt-min=40&rtt-max=200&reorder-buffer=100,rist://10.9.1.183:5004?cname=RECEIVER02&buffer-min=50&buffer-max=200&rtt-min=40&rtt-max=200&reorder-buffer=100" -o udp://127.0.0.1:5001

ristreceiver --buffer 300 -i "rist://127.0.0.1:2235?cname=RECEIVER01&buffer-min=50&buffer-max=200&rtt-min=40&rtt-max=200&reorder-buffer=100" -o udp://127.0.0.1:5001
```

### Test manually

```bash
ristsender --buffer 50 -i udp://127.0.0.1:5001 -o "rist://@[::]:5000?cname=SENDER01&buffer-min=50&buffer-max=400&rtt-min=40&rtt-max=350&reorder-buffer=100&weight=20"
## Actual
ristsender --buffer 50 -i rtp://127.0.0.1:5001 -o "rist://@[::]:5000?cname=sender1&buffer-min=50&buffer-max=60&weight=20"
## Test
ristsender --buffer 50 -i udp://127.0.0.1:5001 -o "rist://@[::]:5000?cname=sender1&buffer-min=50&buffer-max=60&weight=20"

ristreceiver --buffer 50 -i "rist://127.0.0.1:5000?cname=RECEIVER01&buffer-min=50&buffer-max=200&rtt-min=40&rtt-max=200&reorder-buffer=100" -o udp://127.0.0.1:5002
```

## GS

```bash
GST_DEBUG=3 gst-launch-1.0 srtserversrc name=srtserversrc uri="srt://0.0.0.0:1234?mode=listener&latency=10" wait-for-connection=false ! tsparse ignore-pcr=true ! tsdemux ignore-pcr=true latency=1 ! opusdec use-inband-fec=true plc=true ! audioconvert ! 'audio/x-raw,rate=48000,format=S16LE,channels=2,channel-mask=(bitmask)0x3' ! queue leaky=2 max-size-time=50000000 flush-on-eos=true ! pulsesink device="MR_PA_SrtOpusInput_3486_17" sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000

GST_DEBUG=3 gst-launch-1.0 srtserversrc name=srtserversrc uri="srt://127.0.0.1:3236?mode=caller&latency=10" wait-for-connection=false ! tsparse ignore-pcr=true ! tsdemux ignore-pcr=true latency=1 ! mpegtsmux alignment=7 latency=1 ! queue leaky=2 max-size-time=200000000 flush-on-eos=true ! udpsink port=5001 host=127.0.0.1 loop=false max-lateness=10000000
# Actual
GST_DEBUG=3 gst-launch-1.0 srtserversrc uri="srt://127.0.0.1:3236?mode=caller&latency=10" wait-for-connection=false name="SrtToRist" ! tsparse ignore-pcr=true ! tsdemux ignore-pcr=true latency=1 ! mpegtsmux alignment=7 latency=1 ! queue leaky=2 max-size-time=200000000 flush-on-eos=true ! udpsink port=22345 host=127.0.0.1 loop=false

GST_DEBUG=3 gst-launch-1.0 udpsrc port=5002 address=127.0.0.1 loop=false ! tsparse ignore-pcr=true ! srtserversink name=srtserversink uri="srt://127.0.0.1:4000?mode=caller&latency=10" wait-for-connection=false sync=false
# Actual
GST_DEBUG=3 gst-launch-1.0 udpsrc port=40000 address=127.0.0.1 loop=false ! tsparse ignore-pcr=true ! queue leaky=2 max-size-time=200000000 flush-on-eos=true ! srtserversink uri="srt://127.0.0.1:4000?mode=caller&latency=10" wait-for-connection=false name="RistToSrt" sync=false

# Test RTP
GST_DEBUG=4 gst-launch-1.0 srtserversrc uri="srt://127.0.0.1:3236?mode=caller&latency=10" wait-for-connection=false name="SrtToRist" ! udpsink port=5001 host=127.0.0.1
## Actual
GST_DEBUG=4 gst-launch-1.0 srtserversrc uri="srt://127.0.0.1:3236?mode=caller&latency=10" wait-for-connection=false name="SrtToRist" ! udpsink port=5001 host=127.0.0.1

GST_DEBUG=3 gst-launch-1.0 udpsrc port=5002 address=127.0.0.1 ! srtserversink uri="srt://127.0.0.1:4000?mode=caller&latency=10" wait-for-connection=false name="RistToSrt" sync=false

# Test as srt relay
GST_DEBUG=4 gst-launch-1.0 srtserversrc uri="srt://127.0.0.1:3236?mode=caller&latency=10" wait-for-connection=false name="SrtToRist" ! tsparse ignore-pcr=true ! queue ! srtserversink uri="srt://127.0.0.1:4000?mode=caller&latency=10" wait-for-connection=false name="RistToSrt" sync=false
```

# Notes

## Implementation we are thinking of

we think to for a start create a rist to srt and srt to rist relay's.
how it will be put together:

### Srt to rist

srtsrc -> udp socket | udp socket -> ristsender

### Rist to srt

ristreceiver -> udp socket | udp socket -> srtsink

Gstreamer will create send the srt to the udp socket and vice versa, then we will use librist to do the rist implementation

rist package:

-   sudo apt install librist-dev
-   sudo apt install rist-tools

## Notes on performance

So far rist seems to be able to operate with much less latency on a bad network than srt, it can run with much lower latency, and is more robust
Another big advantage is that it can do link bonding

### Bonding methods

-   Load sharing
    -   send packets over both links, so in effect you bigger bandwidth,
    -   link weights, can send more data over the one or other link, but if one of the links start failing, it will fallback to the other
    -   YOu can for example have one expensive data link and a cheap bad quality one, and use the cheap one as the main one, and the expensive one as backup for better reliability
-   Broadcast
    -   Send the same packet over 2 or more links, this is if you want more reliability
