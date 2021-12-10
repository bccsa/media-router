arecord uses a lot less CPU to capture an audio input compared to ffmpeg. Therefore arecord is preferred to capture audio. There is however a bigger latency when piping arecord into ffmpeg compared to piping to aplay directly.

The problem only seems to exist when piping from arecord to ffmpeg, and not when piping between ffmpeg processes, or when ffmpeg pipes to aplay.

250ms Delay when piping arecord into ffmpeg:
arecord -D plughw:CARD=S2,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100 | \
ffmpeg -f s16le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 44100 -c:a pcm_s16le -i - -f s16le -c:a pcm_s16le -ac 2 -sample_rate 44100 - | \
aplay -D hw:CARD=Headphones,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100

arecord -D plughw:CARD=S2,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100 | \
ffmpeg -f s16le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 44100 -c:a pcm_s16le -i - -f s16le -c:a copy - | \
aplay -D hw:CARD=Headphones,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100


arecord -D plughw:CARD=S2,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100 | \

No delay when ffmpeg captures and outputs to aplay:
ffmpeg -f alsa -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 44100 -c:a pcm_s16le -i plughw:CARD=S2,DEV=0 -f s16le -c:a pcm_s16le -ac 2 -sample_rate 44100 - | \
aplay -D hw:CARD=Headphones,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100

Piping ffmpeg into ffmpeg gives no additional delay:
ffmpeg -f alsa -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 44100 -c:a pcm_s16le -i plughw:CARD=S2,DEV=0 -f s16le -c:a pcm_s16le -ac 2 -sample_rate 44100 - | \
ffmpeg -f s16le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 44100 -c:a pcm_s16le -i - -f s16le -c:a pcm_s16le -ac 2 -sample_rate 44100 - | \
aplay -D hw:CARD=Headphones,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100

Try to set the file type for arecord (still a delay)
arecord -t raw -D plughw:CARD=S2,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100 | \
ffmpeg -f s16le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -ac 2 -sample_rate 44100 -c:a pcm_s16le -i - -f s16le -c:a pcm_s16le -ac 2 -sample_rate 44100 - | \
aplay -D hw:CARD=Headphones,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100

Initially less delay, but gives many underruns, and delay increases
arecord -D plughw:CARD=S2,DEV=0 -c 2 -f S16_LE -r 44100 | \
ffmpeg -fflags nobuffer -flags low_delay -i - -f s16le -c:a pcm_s16le -ac 2 -sample_rate 44100 - | \
aplay -D hw:CARD=Headphones,DEV=0 --buffer-size=2048 -c 2 -f S16_LE -r 44100


Errors after SSL2 stops:
AudioMixer | MicInput: size= 1048544kB time=03:22:53.59 bitrate= 705.6kbits/s speed=   1x    
AudioInput | SSL2: Closed (0)
AudioMixer | MicInput: size= 1048574kB time=03:22:53.94 bitrate= 705.6kbits/s speed=   1x    
video:0kB audio:1048574kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.000000%

AudioOutput | Output: Stopping aplay...
AudioMixer | MicInput: Closed (0)
AudioOutput | Output: Closed (null)
AudioInput | SSL2: Restarting arecord...
AudioInput | SSL2: Starting arecord...
AudioMixer | MicInput: Restarting ffmpeg...
AudioOutput | Output: Starting aplay...
AudioInput | SSL2: Stopping arecord...
AudioMixer | MicInput: Stopping ffmpeg...
AudioOutput | Output: Stopping aplay...
Uncaught Error [ERR_STREAM_WRITE_AFTER_END]: write after end