#!/bin/bash

# Get the platform
platform=$(dpkg --print-architecture | xargs)
# Get the OS codename
oscode=$(dpkg --status tzdata|grep Provides|cut -f2 -d'-' | xargs)

# Run the installation script for the current OS / platform. See ./dev directory for supported OS / platforms.
sudo bash ./dev/install-dependencies-$oscode-$platform.sh
