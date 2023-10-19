#!/bin/bash

# Installation script to install development dependencies & tools on Ubuntu 23.04 (lunar) amd64 (64bit)

sudo apt-get -y update
sudo apt-get -y install nodejs npm
sudo apt-get -y install srt-tools
sudo apt-get -y install git
sudo apt-get -y install pulseaudio-utils
sudo apt-get -y install libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-tools gstreamer1.0-x gstreamer1.0-alsa gstreamer1.0-gl gstreamer1.0-gtk3 gstreamer1.0-qt5 gstreamer1.0-pulseaudio

git submodule update --init

cd server
npm install
cd ..

cd client
npm install
cd ..

cd tailwind
npm install
cd ..

# Gstreamer node-addon-api 
cd server/gst_modules/SrtVideoPlayer
npm i
cd ../..
