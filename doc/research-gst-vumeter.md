# base 

```bash 
GST_DEBUG=level:6 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=2 ! level ! fakesink
```


```bash
GST_DEBUG=2 gst-launch-1.0 pulsesrc device=MR_PA_SoundProcessor_5127_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=1 ! audioconvert ! audiorate ! equalizer-10bands name="eq" band0=0 band1=0 band2=0 band3=0 band4=0 band5=0 band6=0 band7=0 band8=0 band9=0  ! calf-sourceforge-net-plugins-Gate name="gate" bypass=true knee=1 ratio=20 threshold=0.440429913 attack=20 release=250 makeup=1 ! calf-sourceforge-net-plugins-Compressor name="compressor" bypass=true knee=2.8 ratio=1 threshold=0.001 makeup=1 mix=1 attack=20 release=250 ! pulsesink device=MR_PA_SoundProcessor_5127_source
```