# media-router

Configurable media router built on NodeJS with [Tailwind CSS](https://tailwindcss.com/), [modular-dm](https://github.com/bccsa/modular-dm) and [modular-ui](https://github.com/bccsa/modular-ui).

The media-router makes use of the following Linux audio and video processes / applications:

-   Pipewire-pulse
-   ffmpeg
-   srt-tools
-   gstreamer
-   mediamtx

The media-router can be used to build flexible distributed media routing applications like remote audio translation systems, video feeds for broadcast, education, etc.

## Branching strategy

<img src="./doc/version-numbering-and-branching.drawio.svg">

For each new release, a branch needs to be create with the following naming: vA.B (where N is the release number, e.g. v1.3).

After the branch is created tags will be used to tag the release on the branch, e.g. v1.3.0.0 (initial tag)

All changes should be merged into the main branch, and then it can be merged / cherry picked into the version branch, and a new tag should be crated.

## Commit naming standard

{type of commit}:{A short description of what has changed / added}

### Commit types

-   feat: A new feature.
-   fix: A bug fix.
-   docs: Documentation changes.
-   refactor: Refactoring production code
-   style: Formatting, missing semicolons, etc. (no production code change).
-   test: Adding missing tests or refactoring existing tests (no production code change).
-   chore: Updating build tasks, dependencies, etc. (no production code change).

## Issue naming standard

Issue name: {type issue}:{A short description of the issue}
Issue description: A detailed description of what is to be done / what needs to be fixed in the issue

### Issue types

-   feat: A new feature.
-   fix: A bug fix.
-   docs: Documentation changes.
-   refactor: Refactoring production code
-   style: Formatting, missing semicolons, etc. (no production code change).
-   test: Adding missing tests or refactoring existing tests (no production code change).
-   chore: Updating build tasks, dependencies, etc. (no production code change).

## Processes

The following processes are part of the media-router project

-   server/router.js - process running on the client devices, responsible for all media processing. router.js receives its configuration upon connection to manager.js.
-   server/manager.js - process responsible for storing and distributing client configurations.

Important: As the media-router makes use of Pipewire-pulse for audio processing, router.js must be run in a user scope (logged in user) and not as a system service.

## Compatibility

This project has been tested on:

-   Raspberry Pi OS Bullseye (armhf / 32bit)
-   Raspberry Pi OS Bookworm (armhf / 64bit)
-   Ubuntu Desktop 24.04 LTS (amd64 / 64bit)

## Modules

-   AudioInput: Capture audio from hardware and output to a PCM stream.
-   AudioOutput: Play a PCM audio stream to hardware.
-   SrtOpusInput: Receives an SRT Opus encoded audio stream
-   SrtOpusOutput: Publishes an audio stream as Opus encoded SRT.
-   Spacer: Visual spacer for web control interface.
-   SrtVideoPlayer: Video Player for a srt video stream
-   SrtVideoEncoder: Video over SRT Encoder
-   SrtRelay: Srt Relay
-   SoundProcessor: PCM Sound Processor
-   SoundDucking: PCM Sound Ducking
-   SrtVideoPlayer: Video Player for a srt video stream
-   HlsPlayer: Hls Video Player
-   WebRTCClient: WebRTC Client WebApp
-   SrtToRist: Receive a SRT stream and outputs it over RIST
-   RistToSrt: Receive a RIST stream and output it over SRT
-   WhepAudioServer: A audio streaming over webrtc (Whep) server

## Centralized management

The media-router is centrally managed and controlled from a manager server. The manager web-interface default address is http://localhost:8080, and listens for router connections on http://localhost:3000.

The media-router process by default points to the locally installed manager but can be pointed to an external manager through the profile manager web-interface on http://localhost:8082

## Local operator web interface

A local operator web-interface is available on http://localhost:8081. This interface can be used for local control of volume controls, etc.

## WebRTC client configuration API

A client config API is included in the WebRTCClient module, serving the configuration on http://[host]:2000/config.json
This can be used to configure client applications to connect to the respective WHEP WebRTC endpoints configured in the module.

_Note_ Media Router does not include a built-in WebRTC server. A server like e.g. MediaMTX can be used as SRT to WebRTC bridge to serve streams as WebRTC to clients.

## Development environment

-   Ensure that your user on the development environment has sudo access (some versions of Debian ships without sudo, and you may need to configure it manually).
-   Clone the project to your development environment.
-   Open /etc/apt/sources.list and uncomment the `deb-src` line to enable the Debian source repository _(needed to build PulseAudio V16)_.
-   Navigate to the `media-router` directory
-   Install dependencies `./install-dependencies.sh`
-   Run router.js and manager.js from Visual Studio Code's Run and Debug menu.

### Building Tailwind CSS

Tailwind CSS is installed in the `tailwind` directory. Scripts for building tailwind is available from this directory. The output CSS files are placed in the respective project directories.

## Performance tuning

### Setting the UDP Buffer limit

Linux is by default configured with a quite small max UDP buffer size. This should be increased on systems with many SRT or other UDP based connections.

Change the max UDP buffer size to e.g. 25 megabytes:

```shell
sudo sysctl -w net.core.rmem_max=26214400
sudo sysctl -w net.core.wmem_max=26214400
```

To make the change permanent, add the following lines to `/etc/sysctl.conf`:

```shell
net.core.rmem_max=26214400
net.core.wmem_max=26214400
```

References:
https://access.redhat.com/documentation/en-us/jboss_enterprise_application_platform/5/html/administration_and_configuration_guide/jgroups-perf-udpbuffer
https://www.systutorials.com/how-to-enlarge-linux-udp-buffer-size/

## Gstreamer c++ library debug

See: [gst_modules](./server/gst_modules/SrtVideoPlayer/README.md)

## **_[Large scale media-router applications](https://teams.microsoft.com/l/message/19:c03ee3df-2ced-415b-a03b-8721d514d3d6_c7308394-f7b9-4a7e-8510-ffb8a5e8b271@unq.gbl.spaces/1709803010063?context=%7B%22contextType%22%3A%22chat%22%7Dexir)_**

-   Important note on large scale media-router applications, you need to increse the default file limit for your pipewire.service and pipewire-pulse.service config files, otherwise you will be limited to 50 pulseaudio loopbacks
-   This can be done by adding the following line in your pipewire.service and pipewire-pulse.service files in /usr/lib/sytstemd/user

```
[Service]
LimitNOFILE=<Your file count>
```
