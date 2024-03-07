pw-loopback --capture-props='{ stream.capture.sink=true }' -C alsa_output.platform-bcm2835_audio.stereo-fallback.monitor -m '[FL FR]' --playback-props='media.class=Audio/Source audio.position=[FL FR]' -n my-virtual-source

# Create jabra Input remap
pw-loopback --capture-props='{ stream.capture.sink=true }' -C alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo.monitor -m '[FL FR]' --playback-props='media.class=Audio/Source audio.position=[FL FR]' -n jabra-remap

# Create jabra output repap
pw-loopback --capture-props='media.class=Audio/Sink audio.position=[FL FR]' -m '[FL FR]' --playback-props='{ stream.capture.sink=true }' -P alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo  -n jabra-out-remap

# Create loopback between 2 virtual sinks
pw-loopback --capture-props='{ stream.capture.sink=true }' -C output.jabra-remap  -m '[FL FR]' --playback-props='{ stream.capture.sink=true }' -P input.jabra-out-remap.monitor  -n jabra-loopback

# Test from blogshit
pw-loopback --capture-props='audio.position=[FL, FL]' -C alsa_output.platform-bcm2835_audio.stereo-fallback.monitor --playback-props='media.class=Audio/Source node.name=testsource'

pw-loopback --capture-props='media.class=Audio/Source node.name=testsink' --playback-props='audio.position=[FL, FL]' -P alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo

pw-loopback --capture-props='audio.position=[FL, FL]' -C testsource --playback-props='audio.position=[FL, FL]' -P testsink  -n jabra-loopback

pw-loopback \
  --capture-props="node.name=alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo" \
  --playback-props="node.name=Remapped Headset, media.class=Audio/Source, audio.channels=2"


# Remap source
pw-loopback --name=test1 --capture-props='{audio.position=[FR FL]}' --playback-props='{media.class=Audio/Source,node.name=alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback,audio.position=[FL FR]}'

# Remap Sink 
pw-loopback --name='test2' --capture-props='{media.class=Audio/Sink,node.name=alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo.monitor,audio.position=[FL FR]}' --playback-props='{node.name=test2_remap,audio.position=[FR FL]}'

# Loopback
pw-loopback --name='loopback' --capture-props='{media.class=Audio/Sink,node.name=my-sink,audio.position=[FL FR]}' --playback-props='{media.class=Audio/Source,node.name=test1,audio.position=[FL FR]}'

# Loopback 2.0
pw-loopback --name=loopback --capture-props='{media.class=Audio/Source,node.name=input.test2,audio.position=[FL FR]}' --playback-props='{media.class=Audio/Source,node.name=output.test1,audio.position=[FL FR]}'

# Virtual sink 
pw-loopback -m '[ FL FR]' --capture-props='media.class=Audio/Sink node.name=my-sink' --playback-props='media.class=Audio/Source node.name=my-sink'

# Pipewire tweak (crackling popping fix)
https://forum.endeavouros.com/t/pipewire-tweak-crackling-popping-fix/32860


# HowTo Troubleshoot crackling in PipeWire
https://forum.manjaro.org/t/howto-troubleshoot-crackling-in-pipewire/82442


# problem with connection limit: the max allowed open files by default with linux 
Link: https://teams.microsoft.com/l/message/19:c03ee3df-2ced-415b-a03b-8721d514d3d6_c7308394-f7b9-4a7e-8510-ffb8a5e8b271@unq.gbl.spaces/1709803010063?context=%7B%22contextType%22%3A%22chat%22%7Dexir