#!/bin/bash

# Installation script to install development dependencies & tools on Debian 12 (bookworm) amd64 (64bit)

sudo apt-get -y update
sudo apt-get -y install nodejs npm
sudo apt-get -y install srt-tools
sudo apt-get -y install ffmpeg
sudo apt-get -y install git
sudo apt-get -y install pulseaudio-utils

git submodule update --init

cd server
npm install
cd ..

cd client
npm install
cd ..
