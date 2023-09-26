# media-router
Configurable media router built on NodeJS with [Tailwind CSS](https://tailwindcss.com/), [modular-dm](https://github.com/bccsa/modular-dm) and [modular-ui](https://github.com/bccsa/modular-ui).

The media-router makes use of the following Linux audio and video processes / applications:
* PulseAudio
* ffmpeg
* srt-tools

The media-router can be used to build flexible distributed media routing applications like remote audio translation systems, video feeds for broadcast, education, etc.

## Processes
The following processes are part of the media-router project
* server/router.js - process running on the client devices, responsible for all media processing. router.js receives its configuration upon connection to manager.js.
* server/manager.js - process responsible for storing and distributing client configurations.

Important: As the media-router makes use of PulseAudio for audio processing, router.js must be run in a user scope (logged in user) and not as a system service.

## Compatibility
This project has been tested on:
* Raspberry Pi OS Bullseye (armhf / 32bit)
* Ubuntu Desktop 22.04 LTS (amd64 / 64bit)

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
* Ensure that your user on the development environment has sudo access (some versions of Debian ships without sudo, and you may need to configure it manually).
* Clone the project to your development environment.
* Open /etc/apt/sources.list and uncomment the ```deb-src``` line to enable the Debian source repository *(needed to build PulseAudio V16)*.
* Navigate to the ```media-router``` directory
* Install dependencies ```./install-dependencies.sh```
* Run router.js and manager.js from Visual Studio Code's Run and Debug menu.

### Building Tailwind CSS
Tailwind CSS is installed in the ```tailwind``` directory. Scripts for building tailwind is available from this directory. The output CSS files are placed in the respective project directories.

## Performance tuning
### Setting the UDP Buffer limit
Linux is by default configured with a quite small max UDP buffer size. This should be increased on systems with many SRT or other UDP based connections.

Change the max UDP buffer size to e.g. 25 megabytes:
```shell
sudo sysctl -w net.core.rmem_max=26214400
sudo sysctl -w net.core.wmem_max=26214400
```

To make the change permanent, add the following lines to ```/etc/sysctl.conf```:
```shell
net.core.rmem_max=26214400
net.core.wmem_max=26214400
```

References:
https://access.redhat.com/documentation/en-us/jboss_enterprise_application_platform/5/html/administration_and_configuration_guide/jgroups-perf-udpbuffer
https://www.systutorials.com/how-to-enlarge-linux-udp-buffer-size/