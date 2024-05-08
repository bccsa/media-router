# base 

```bash 
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=2 ! pulsesink device=MR_PA_SoundProcessor_4157_source
```

# EQ 
```bash
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=2 ! equalizer-10bands band0=-24 band1=-24 band2=-24 band3=12 band4=12 band5=12 band6=12 band7=-24 band8=-24 band9=-24 ! pulsesink device=MR_PA_SoundProcessor_4157_source

GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=1 ! equalizer-10bands band0=-24 band1=-24 band2=-24 band3=-24 band4=-24 band5=-24 band6=-24 band7=-24 band8=-24 band9=-24 ! pulsesink device=MR_PA_SoundProcessor_4157_source
```