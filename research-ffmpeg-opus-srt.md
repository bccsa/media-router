# Encode to opus file
arecord -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 2048 | opusenc --bitrate 30 --raw --raw-bits 16 --raw-rate 48000 --raw-chan 1 - test.opus

# Play input to output
arecord -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 512 | aplay -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 4096 -

# Decode file to output
opusdec test.opus - | aplay -D "default" -c 1 -r 48000 -f S16_LE -t raw -

# Encode and decode input to output
arecord -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 2048 | opusenc --bitrate 30 --raw --raw-bits 16 --raw-rate 48000 --raw-chan 1 - - | opusdec - - | aplay -D "default" -c 1 -r 48000 -f S16_LE -t raw -

arecord -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 512 | opusenc --bitrate 64 --raw --raw-bits 16 --raw-rate 48000 --raw-chan 1 --max-delay 0 --comp 0 --framesize 2.5 --hard-cbr - - | opusdec - - | aplay -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 512 -

arecord -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 64 | opusenc --bitrate 64 --raw --raw-bits 16 --raw-rate 48000 --raw-chan 1 --max-delay 0 --comp 0 --framesize 2.5 --hard-cbr - - | opusdec - - | aplay -D "default" -c 1 -r 48000 -f S16_LE -t raw --buffer-size 64 -


# ffmpeg test
ffmpeg -f alsa -i "default" -c:a libopus -b:a 64000 -f mpegts srt://127.0.0.1:1234?mode=listener
ffmpeg -f mpegts -c:a libopus -i srt://127.0.0.1:1234?mode=caller -c:a pcm_s16le -f alsa "default"

# ffmpeg test 2
ffmpeg -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -i "default" -c:a libopus -b:a 64000 -f mpegts "srt://127.0.0.1:1234?mode=listener&latency=20"
ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f mpegts -c:a libopus -i "srt://127.0.0.1:1234?mode=caller&latency=20" -c:a pcm_s16le -f alsa "default"

# ffmpeg test 3
ffmpeg -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -i "default" -ac 1 -c:a libopus -b:a 40000 -vbr off -frame_duration 2.5 -application lowdelay -compression_level 0 -f mpegts "udp://127.0.0.1:5555?pkt_size=500"
srt-live-transmit udp://:5555 "srt://:1234?mode=listener&latency=40"
ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f mpegts -c:a libopus -i "srt://127.0.0.1:1234?mode=caller&latency=40" -c:a pcm_s16le -f alsa "default"

# ffmpeg test 4 (vbr auto quality)
ffmpeg -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -i "default" -ac 1 -c:a libopus -frame_duration 2.5 -application lowdelay -compression_level 0 -f mpegts "udp://127.0.0.1:5555?pkt_size=500"
srt-live-transmit udp://:5555 "srt://:1234?mode=listener&latency=40"
ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f mpegts -c:a libopus -i "srt://127.0.0.1:1234?mode=caller&latency=40" -c:a pcm_s16le -f alsa "default"

# ffmpeg test 5 (vbr auto quality fec)
ffmpeg -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -i "default" -ac 1 -c:a libopus -frame_duration 2.5 -application lowdelay -compression_level 0 -packet_loss 5 -fec 1 -f mpegts "udp://127.0.0.1:5555?pkt_size=188"
srt-live-transmit udp://:5555 "srt://:1234?mode=listener&latency=40"
ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f mpegts -c:a libopus -i "srt://127.0.0.1:1234?mode=caller&latency=40" -c:a pcm_s16le -f alsa "default"

# ffmpeg test 5 (vbr auto quality fec buffer_size)
ffmpeg -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -i "default" -ac 1 -c:a libopus -frame_duration 2.5 -application lowdelay -compression_level 0 -packet_loss 5 -fec 1 -f mpegts "udp://127.0.0.1:5555?pkt_size=188&buffer_size=0"
srt-live-transmit udp://:5555 "srt://:1234?mode=listener&latency=40"
ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f mpegts -c:a libopus -i "srt://127.0.0.1:1234?mode=caller&latency=40" -c:a pcm_s16le -f alsa "default"
