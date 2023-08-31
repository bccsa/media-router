#!/bin/bash

# Get the platform
platform=$(dpkg --print-architecture | xargs)
# Get the OS codename
oscode=$(lsb_release -a|grep Codename|cut -f2 -d':' | xargs)

# Run the installation script for the current OS / platform. See ./dev directory for supported OS / platforms.
sudo bash ./dev/install-dependencies-$oscode-$platform.sh
