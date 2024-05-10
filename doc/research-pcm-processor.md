# base 

```bash 
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=2 ! pulsesink device=MR_PA_SoundProcessor_4157_source
```

# EQ 
```bash
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=2 ! equalizer-10bands band0=-24 band1=-24 band2=-24 band3=12 band4=12 band5=12 band6=12 band7=-24 band8=-24 band9=-24 ! pulsesink device=MR_PA_SoundProcessor_4157_source

GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=1 ! equalizer-10bands band0=-24 band1=-24 band2=-24 band3=-24 band4=-24 band5=-24 band6=-24 band7=-24 band8=-24 band9=-24 ! pulsesink device=MR_PA_SoundProcessor_4157_source
```

## Audio Compression with ffmpeg 
https://superuser.com/questions/1104534/how-to-use-compressor-with-ffmpeg
-af acompressor=threshold=0.089:ratio=9:attack=200:release=1000

```bash
ffmpeg -f pulse -i alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.mono-fallback
```

## lsp-plug-in-plugins-lv2-compressor-stereo
```bash
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.mono-fallback ! lsp-plug-in-plugins-lv2-compressor-stereo ! pulsesink device=alsa_output.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.analog-stereo

# Add side chain
GST_DEBUG=comp:5 gst-launch-1.0 pulsesrc device=alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.mono-fallback name=src_1 ! lsp-plug-in-plugins-lv2-compressor-mono scl=true name=comp ! fakesink pulsesrc name=src_2 device=alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback ! comp.

GST_DEBUG=comp:5 gst-launch-1.0 pulsesrc device=alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.mono-fallback name=src_1 ! audio/x-raw,rate=48000,format=S16LE,channels=1 ! audioconvert ! audiorate ! equalizer-10bands name="eq" band0=0 band1=0 band2=0 band3=0 band4=0 band5=0 band6=0 band7=0 band8=0 band9=0 !  calf-sourceforge-net-plugins-Compressor name="compressor" bypass=false knee=7.2 ratio=12.5 threshold=0.894976563 attack=672.95 release=1180.04 ! pulsesink device=MR_PA_SoundProcessor_2145_source

GST_DEBUG=comp:5 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_2145_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=1 ! equalizer-10bands name="eq" band0=0 band1=0 band2=0 band3=0 band4=0 band5=0 band6=0 band7=0 band8=0 band9=0 ! calf-sourceforge-net-plugins-Compressor name="compressor" bypass=false knee=7.2 ratio=12.5 threshold=0.894976563 attack=672.95 release=1180.04 ! pulsesink device=MR_PA_SoundProcessor_2145_source
```

