#!/bin/bash
until /usr/bin/node /opt/media-router/router.js /etc/media-router/config.json; do
    echo "media-router stopped with code $?.  Restarting" >&2
    sleep 1
done