gst-launch-1.0 alsasrc device="hw:1,0" buffer-time=10000 ! audioconvert ! audioresample ! alsasink device="hw:1,0" buffer-time=10000


# fastest, but complains
gst-launch-1.0 pulsesrc device="alsa_input.usb-Razer_Razer_Kraken_V3_X_00000000-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample  ! pulsesink device="alsa_output.usb-Razer_Razer_Kraken_V3_X_00000000-00.analog-stereo" buffer-time=10000

# About equally fast without complaining
gst-launch-1.0 pulsesrc device="alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample ! queue leaky="upstream" ! pulsesink device="alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000

# With opus encoder and decoder

gst-launch-1.0 pulsesrc device="alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample ! queue leaky="upstream" ! opusenc ! opusdec ! audioconvert ! audioresample ! pulsesink device="alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000

# Add mpegts

gst-launch-1.0 pulsesrc device="alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample ! queue leaky="upstream" ! opusenc ! opusparse ! mpegtsmux name=mux latency=1 ! tsdemux latency=1 ignore-pcr=true ! opusdec ! audioconvert ! audioresample ! pulsesink device="alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000

# Add SRT

gst-launch-1.0 pulsesrc device="alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample ! queue leaky="upstream" ! opusenc audio-type="restricted-lowdelay" bitrate-type="constrained-vbr" ! opusparse ! mpegtsmux name=mux latency=1 ! srtsink wait-for-connection=false sync=false uri="srt://0.0.0.0:1234?mode=listener&latency=1"

gst-launch-1.0 srtsrc wait-for-connection=false uri="srt://127.0.0.1:1234?mode=caller&latency=1" ! tsdemux latency=1 ignore-pcr=true ! opusparse ! opusdec ! audioconvert ! audioresample ! queue leaky="upstream" ! pulsesink device="alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000

# Remove opusparse, add sync=false

gst-launch-1.0 pulsesrc device="alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample ! queue leaky="upstream" ! opusenc audio-type="restricted-lowdelay" bitrate-type="constrained-vbr" ! mpegtsmux name=mux latency=1 ! srtsink wait-for-connection=false sync=false uri="srt://0.0.0.0:1234?mode=listener&latency=1"

gst-launch-1.0 srtsrc wait-for-connection=false uri="srt://127.0.0.1:1234?mode=caller&latency=1" ! tsdemux latency=1 ignore-pcr=true ! opusdec ! audioconvert ! audioresample ! queue leaky="upstream" ! pulsesink sync=false device="alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000

# Add max-lateness

gst-launch-1.0 pulsesrc device="alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 ! audioconvert ! audioresample ! queue leaky="downstream" max-size-time=1000000000 ! opusenc audio-type="restricted-lowdelay" bitrate-type="constrained-vbr" ! mpegtsmux name=mux latency=1 ! srtsink wait-for-connection=false sync=false uri="srt://0.0.0.0:1234?mode=listener&latency=1"

gst-launch-1.0 srtsrc wait-for-connection=false uri="srt://127.0.0.1:1234?mode=caller&latency=1" ! tsdemux latency=1 ignore-pcr=true ! opusdec ! audioconvert ! audioresample ! queue leaky="downstream" max-size-time=1000000000 ! pulsesink sync=false device="alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo" buffer-time=10000 max-lateness=1000000