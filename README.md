# media-router
Configurable media router built on NodeJS with [Tailwind CSS](https://tailwindcss.com/), [modular-dm](https://github.com/bccsa/modular-dm) and [modular-ui](https://github.com/bccsa/modular-ui).

The media-router makes use of the following Linux audio and video processes / applications:
* PulseAudio
* ffmpeg
* srt-tools

The media-router can be used to build flexible distributed media routing applications like remote audio translation systems, video feeds for broadcast, education, etc.

# Processes
The following processes are part of the media-router project
* server/router.js - process running on the client devices, responsible for all media processing. router.js receives its configuration upon connection to manager.js.
* server/manager.js - process responsible for storing and distributing client configurations.

Important: As the media-router makes use of PulseAudio for audio processing, router.js must be run in a user scope (logged in user) and not as a system service.

## Compatibility
This project has been tested on Raspberry Pi OS Bullseye (armhf / 32bit).

## Modules
* AudioInput: Capture audio from hardware and output to a PCM stream.
* AudioOutput: Play a PCM audio stream to hardware.
* SrtOpusInput: Receives an SRT Opus encoded audio stream
* SrtOpusOutput: Publishes an audio stream as Opus encoded SRT. 
* Spacer: Visual spacer for web control interface.

Planned modules:
* Video encoding & decoding
* SRT video streaming
* Low latency WiFi audio streaming to mobile devices

## Centralized management
The media-router is centrally managed and controlled from a manager server. The manager web-interface default address is http://localhost:8080, and listens for router connections on http://localhost:3000.

The media-router process by default points to the locally installed manager but can be pointed to an external manager through the profile manager web-interface on http://localhost:8082

## Local operator web interface
A local operator web-interface is available on http://localhost:8081. This interface can be used for local control of volume controls, etc.

## Development environment
* Clone the project to your development environment.
* Open /etc/apt/sources.list and uncomment the ```deb-src``` line to enable the Debian source repository (Raspberry Pi OS).
* Navigate to the ```media-router``` directory
* Install dependencies ```./install-dependencies.sh```
* Run router.js and manager.js from Visual Studio Code's Run and Debug menu.

### Building Tailwind CSS
Tailwind CSS is installed in the ```tailwind``` directory. Scripts for building tailwind is available from this directory. The output CSS files are placed in the respective project directories.
