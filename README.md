# media-router
Configurable media router.
Modules (devices):
* AudioInput: Capture audio from hardware and output to a PCM stream.
* AudioOutput: Play a PCM audio stream to hardware.
* AudioMixer: Mix audio via AudioMixerInputs and output to a PCM stream.
* AudioMixerInput: Input audio from a PCM audio stream into a AudioMixer. Includes a web control interface with mute and volume controls.
* RtpOpusInput: Receive Opus encoded audio via RTP, and decode to PCM.
* RtpOpusOutput: Encode PCM audio to Opus and send via RTP.
* SrtInput: Receives an SRT stream and publishes it to a UDP socket.
* SrtOutput: Reads a UDP socket and publishes it as a SRT stream.
* Spacer: Visual spacer for web control interface.


The web control interface is available on port 8081.

## Compatibility
This project has been tested on Raspberry Pi OS Buster and Ubuntu 20.04

## Dependencies
Run the installation script:
```
sudo ./install.sh
```
## uiControl 
Limitation of printing taf tested
* cant not add a childElement inside the ChildElement 