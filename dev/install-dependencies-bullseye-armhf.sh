#!/bin/bash

# Installation script to install development dependencies & tools on Raspberry Pi OS Bullseye armhf (32bit)

sudo apt-get -y update
sudo apt-get -y install nodejs npm
sudo apt-get -y install srt-tools
sudo apt-get -y install ffmpeg
sudo apt-get -y install git

# Dependencies needed to build PulseAudio 16.1
sudo apt-get -y build-dep pulseaudio
sudo apt-get -y install meson

git submodule update --init

cd server
npm install
cd ..

cd client
npm install
cd ..

# Build and Install PulseAudio 16.1 (version included on Raspberry Pi OS - V14 - does not include latency control on null-sink modules)
# References:
# https://www.freedesktop.org/wiki/Software/PulseAudio/Download/
# https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/Developer/PulseAudioFromGit/
wget https://freedesktop.org/software/pulseaudio/releases/pulseaudio-16.1.tar.xz
tar -xvf pulseaudio-16.1.tar.xz
cd pulseaudio-16.1
meson build
ninja -C build
sudo ninja -C build install
sudo ldconfig
cd ..
rm -rf pulseaudio-16.1
rm -f pulseaudio-16.1.tar.xz
