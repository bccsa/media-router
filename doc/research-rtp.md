```shell
ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -flush_packets 1 -fflags nobuffer -flags low_delay -channels 2 -sample_rate 44100 -c:a pcm_s32le -f pulse -i alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo -af aresample=48000 -f rtp -c:a libopus -b:a 64000 -sample_rate 48000 -ac 2 -packet_loss 5 -fec 1 -compression_level 5 udp://127.0.0.1:9999?buffer_size=16000

srt-live-transmit udp://127.0.0.1:5555?rcvbuf=1024 srt://127.0.0.1:5566?mode=listener&latency=1

srt-live-transmit srt://127.0.0.1:5566?mode=caller udp://127.0.0.1:5557?sndbuf=1024

ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -flush_packets 1 -fflags nobuffer -flags low_delay -protocol_whitelist file,udp,rtp -reorder_queue_size 0 -c:a libopus -i rtpin.sdp -channels 2 -sample_rate 48000 -af aresample=44100 -channels 2 -sample_rate 44100 -c:a pcm_s32le -buffer_duration 100 -f pulse -device alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo "test stream"
```

rtp file:
```rtpin```
```shell
v=0
o=- 0 0 IN IP4 127.0.0.1
s=No Name
c=IN IP4 0.0.0.0
t=0 0
a=tool:libavformat 58.20.100
m=audio 5566 RTP/AVP 97
b=AS:64000
a=rtpmap:97 opus/48000/2


v=0
o=- 0 0 IN IP4 127.0.0.1
s=No Name
c=IN IP4 124.0.0.1
t=0 0
a=tool:libavformat 58.45.100
m=audio 0 RTP/AVP 97
b=AS:64
a=rtpmap:97 opus/48000/2
a=fmtp:97 sprop-stereo=1
a=control:streamid=0
```
?pkt_size=188&buffer_size=1024
-f rtp srt://127.0.0.1:5555?transtype=live&latency=1&mode=caller