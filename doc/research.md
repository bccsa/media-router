ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -c:a libopus -sample_rate 48000 -ac 2 -packet_loss 5 -fec 1 -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct -f mpegts /dev/null


ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a libopus -sample_rate 48000 -b:a 64000 -ac 1 -packet_loss 5 -fec 0 -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct -f mpegts test.ts




ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a libopus -sample_rate 48000 -b:a 64000 -ac 1 -packet_loss 5 -fec 0 -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct -f mpegts "udp://127.0.0.1:2345?pkt_size=188&buffer_size=0"

ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i testsink1.monitor -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a libopus -sample_rate 48000 -b:a 64000 -ac 1 -packet_loss 5 -fec 1 -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct -f mpegts "udp://127.0.0.1:2345?pkt_size=188&buffer_size=0"

"udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&buffer_size=0"

udp://127.0.0.1:${this._udpSocketPort}

alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo

alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

# ffmpeg loopback
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo \
test.wav

ffmpeg -i test.wav -f pulse alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -hide_banner -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -c:a pcm_s16le -f s16le - | ffmpeg -ac 2 -sample_rate 48000 -f s16le -i - -f pulse alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -y -hide_banner -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -c:a pcm_s16le -f s16le test1.wav
ffmpeg -y -hide_banner -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo test1.wav
ffmpeg -y -ac 2 -sample_rate 48000 -f s16le -i test1.wav -f pulse alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -y -hide_banner -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -c:a pcm_s16le -f s16le - | \
ffmpeg -y -hide_banner -ac 2 -sample_rate 48000 -f s16le -i - -f pulse alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -rtbufsize 512 -blocksize 512 -flush_packets 1 -af asetpts=NB_CONSUMED_SAMPLES/SR/TB  -c:a pcm_s16le -f s16le - | \
ffmpeg -y -flush_packets 1 -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 48000 -f s16le -i - -rtbufsize 512 -blocksize 512 -flush_packets 1 -f pulse alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -y -hide_banner -c:a pcm_s16le -r 48000 -ac 2 -f s16le -i test1.wav -f alsa pulse:alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -f alsa -i pulse:alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a pcm_s16le -f s16le - | \
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -ac 2 -sample_rate 48000 -f s16le -i - -f alsa pulse:alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -rtbufsize 512 -blocksize 512 -flush_packets 1 -af asetpts=NB_CONSUMED_SAMPLES/SR/TB  -c:a pcm_s16le -f s16le - | \
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 48000 -f s16le -i - -rtbufsize 512 -blocksize 512 -flush_packets 1 -c:a pcm_s16le - | \
paplay -d alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo


ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -flush_packets 1 -f pulse \
-i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -ac 2 -sample_rate 48000 -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a pcm_s16le -f s16le - | \
paplay -d alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo --rate=48000 --channels=2 --format=s16le --raw --latency-msec=1


# Working configuration (route source to sink via ffmpeg)
# See https://www.reddit.com/r/ffmpeg/comments/pjyhk1/minimize_audio_input_latency/ for info on pulseaudio buffer_size
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -f pulse -ac 2 -sample_rate 48000 -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a pcm_s16le -f s16le - | \
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -f s16le -ac 2 -sample_rate 48000 -i - -f pulse -buffer_size 4096 alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo

# Route null-sink source to null-sink sink (issues with latency between loopbacks and null-sinks)
pactl load-module module-null-sink sink_name=testSink1
pactl load-module module-null-sink sink_name=testSink2
pactl load-module module-loopback source=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo sink=testSink1 latency_msec=1 channels=2 adjust_time=0
pactl load-module module-loopback source=testSink2.monitor sink=alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo latency_msec=1 channels=2 adjust_time=0
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -f pulse -fragment_size 16 -ac 2 -sample_rate 48000 -i testSink1.monitor -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a pcm_s16le -f s16le - | \
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -f s16le -ac 2 -sample_rate 48000 -i - -f pulse -fragment_size 16 -buffer_size 4096 testSink2


pactl load-module module-loopback source=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo sink=alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo latency_msec=1 channels=2
pactl load-module module-loopback source=testSink1.monitor sink=testSink2 latency_msec=1 channels=2

# Route null-sink source to null-sink sink. Connect input source to null-sink with parec & paplay. Do the same for connecting the second null-sink to the output
# https://thelinuxexperiment.com/fix-pulseaudio-loopback-delay/
```shell
pactl load-module module-null-sink sink_name=testSink1 rate=44100 format=s16le channels=2 latency_msec=1
pactl load-module module-null-sink sink_name=testSink2 sink_properties=max_latency_msec=20
pacat -r --latency-msec=1 --device alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo | pacat -p --latency-msec=1 --device testSink1
pacat -r --latency-msec=1 --device testSink2.monitor | pacat -p --latency-msec=1 --device alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo
pacat -r --latency-msec=1 --device testSink1.monitor | pacat -p --latency-msec=1 --device testSink2

pacat -r --latency-msec=1 --device testSink1.monitor | pacat -p --latency-msec=1 --device alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo
```
*Issue: module-null-sink introduces additional latency, which I was unable to remove. Newer versions of PulseAudio includes a max_latency_msec option according to the documentation (V15+), but I could not get that to work with pactl*

# Use a pipe-sink and source to connect ffmpeg
This can be used for processing nodes (e.g. an EQ, Compressor, etc.). Currently not usable due to latency issues.

https://unix.stackexchange.com/questions/576785/redirecting-pulseaudio-sink-to-a-virtual-source

```shell
pactl load-module module-pipe-sink sink_name=ffmpeg_in rate=44100 format=s16le channels=2 file=/tmp/ffmpeg_in
pactl load-module module-pipe-source source_name=ffmpeg_out rate=44100 format=s16le channels=2 file=/tmp/ffmpeg_out
pactl load-module module-loopback source=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo sink=ffmpeg_in rate=44100 format=s16le channels=2 latency_msec=1
pactl load-module module-loopback source=ffmpeg_out sink=alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo rate=44100 format=s16le channels=2 latency_msec=1
ffmpeg -y -re -hide_banner -probesize 32 -analyzeduration 0 -f s16le -ac 2 -sample_rate 44100 -i /tmp/ffmpeg_in -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a pcm_s16le -f s16le - > /tmp/ffmpeg_out
```

*Issue: pipe fifo buffer size is not restricted, resulting in a lot of data being buffered and huge latencies. Consider creating a process that drops backpressure data from the pipe (e.g. in NodeJS)*

# Compile pulseaudio
Needed if PulseAudio 15 or newer is needed (included version on RPI OS is 14)
N/A: https://ubuntuforums.org/showthread.php?t=2210602
https://gist.github.com/ford-prefect/924cb946631d82c8195b464a7be21d53
Add deb-src (/etc/apt/sources.list) https://forums.raspberrypi.com/viewtopic.php?t=73666

Install build dependencies
sudo apt-get build-dep pulseaudio

Download and extract the required PulseAudio release: https://www.freedesktop.org/wiki/Software/PulseAudio/Download/
Build PulseAudio: https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/Developer/PulseAudioFromGit/






# Test connecting pipe-source to sink, and playing from source to named pipe to test latency
Working setup. Important: Start the pipe-source to soundcard sink connection first so that the named pipe fifo stays empty, as we have no way to drain the fifo.
```shell
# load pipe-source module
pactl load-module module-pipe-source source_name=ffmpeg_out rate=44100 format=s16le channels=2 file=/tmp/ffmpeg_out

# Connect pipe-source to soundcard sink
parec --device=ffmpeg_out --rate=44100 --channels=2 --format=s16le --latency=1 --raw | paplay --device=alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo --rate=44100 --channels=2 --format=s16le --latency=1 --raw

# record soundcard source, and output stream to named pipe created by pipe-source
parec --device=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo --rate=44100 --channels=2 --format=s16le --latency=1 --raw /tmp/ffmpeg_out
```

# Test if a null sink's monitor source produces a silent stream or no stream when no audio is played to the sink.
```shell
pactl load-module module-null-sink rate=44100 format=s16le channels=2 sink_name=test123
parec --device=test123.monitor --rate=44100 --channels=2 --format=s16le --latency=1 --raw
```
result: no audio

# Generate silent audio
```shell
pactl load-module module-sine-source rate=44100 source_name=silent
pactl set-source-mute silent 1
parec silent
```
result: when muted or volume set to 0, the source stops streaming data

# Test if ffmpeg continues to play on empty stream
```shell
pactl load-module module-pipe-sink sink_name=test rate=44100 format=s16le channels=2 file=/tmp/test_sink
ffmpeg -y -hide_banner -probesize 32 -analyzeduration 0 -f s16le -ac 2 -sample_rate 44100 -i /tmp/test_sink -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a pcm_s16le -f s16le /dev/null
```

Try playing feeding some audio to the pipe sink, and removing it to check if ffmpeg still works
```shell
pactl load-module module-loopback source=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo sink=test
pactl unload-module <module-ID>
```
result: ffmpeg seems to handle the stopping and starting of streams well as no EOF signals are sent through the pipe. Need to test if it affects latency / audio quality

# Test if parec can drain the named pipe of a pipe-source
```shell
# load pipe-source module
pactl load-module module-pipe-source source_name=test rate=44100 format=s16le channels=2 file=/tmp/test

# Start recording process to drain pipe
parec --device=test --rate=44100 --channels=2 --format=s16le --latency=1 --raw /dev/null

# record from mic into pipe
parec --device=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo --rate=44100 --channels=2 --format=s16le --latency=1 --raw /tmp/test

# connect source to speaker sink to check latency
pactl load-module module-loopback source=test sink=alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo latency_msec=1
```
result: parec works well to keep the pipe-source's named pipe drained, preventing latency buildup.