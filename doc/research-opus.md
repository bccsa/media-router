# Installation
```shell
sudo apt install opus-tools
```
# Create virtual sink
```shell
pactl load-module module-null-sink sink_name=opus_test format=s16le rate=44100 channels=2 sink_properties="latency_msec=20"
```
# Connect source to sink
```shell
pactl load-module module-loopback source=alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo sink=opus_test format=s16le rate=44100 channels=2 latency_msec=20
```
# Record and play from null-sink's monitor source
```shell
pacat --record --device opus_test.monitor --format s16le --rate 44100 --channels 2 --volume 65536 --latency-msec 20 --raw | pacat --play --device alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo --format s16le --rate 44100 --channels 2 --volume 65536 --latency-msec 20 --raw
```

# Opus enc
```shell
pacat --record --device opus_test.monitor --format s16le --rate 44100 --channels 2 --volume 65536 --raw | opusenc --bitrate 64
```


