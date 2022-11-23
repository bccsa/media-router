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
This project has been tested on Raspberry Pi OS Bullseye

## Dependencies
Run the installation script:
```
sudo ./install-dependencies.sh
```

## Development environment
* Clone the project to your Raspberry Pi.
* Navigate to the media-router directory
* Run the router.js with NodeJS: ```node server.js```
* A default configuration file will be created listing all the modules. This file can be modified to create a working setup. The server.js script should be restarted to apply the configuration changes.

## Example configurations
To do
