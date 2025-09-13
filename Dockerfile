# Use the official Node.js Bookworm-based image
FROM node:bookworm-slim

# Set the working directory inside the container
WORKDIR /app

# Install OS dependencies
RUN apt-get -y update && \
    apt-get -y install --no-install-recommends \
    build-essential git \
    gobject-introspection \
    libgirepository1.0-dev \
    libcairo2 \
    libcairo2-dev\
    gstreamer1.0-tools gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-libav \
    libnice10 gstreamer1.0-nice gir1.2-gst-plugins-bad-1.0 \
    gir1.2-gst-plugins-base-1.0 \
    build-essential libgirepository1.0-dev libcairo2-dev \
    gir1.2-gtk-3.0 pkg-config \
    pulseaudio-utils \
    alsa-utils \
    srt-tools \
    net-tools \
    git \
    pkg-config \
    build-essential \
    libnice10 \
    libgtk-3-dev \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    libgirepository1.0-dev \
    libcairo2-dev \
    gir1.2-gtk-3.0 \ 
    gstreamer1.0-nice \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-tools \
    # gstreamer1.0-x \
    gstreamer1.0-alsa \
    # gstreamer1.0-gl \
    # gstreamer1.0-gtk3 \
    gstreamer1.0-pulseaudio \
    gir1.2-gst-plugins-base-1.0 \
    gir1.2-gst-plugins-bad-1.0 \
    calf-plugins \
    streamlink \
    build-essential \
    python3 \
    python3-pip \
    python3-mako \
    python3-setuptools \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy the entire project into the container
COPY . .

# alternativly clone the git repo 
# RUN git clone https://github.com/bccsa/media-router.git .
# RUN git submodule update --init --recursive
# Initialize git submodules (assumes the `.git` dir is copied as well)

# Install node-gyp
RUN npm install -g node-gyp

# Install npm dependencies in each relevant directory
RUN cd server && npm install && cd .. && \
    cd client && npm install && cd .. && \
    cd local-profileman && npm install && cd .. && \
    cd tailwind && npm install && cd ..

# Build the Gstreamer modules
RUN cd server/gst_modules/GstGeneric && \
    node-gyp clean && rm -rf build node_modules && node-gyp configure && npm install && cd ../../..
RUN cd server/gst_modules/GstvuMeter && \
    node-gyp clean && rm -rf build node_modules && node-gyp configure && npm install && cd ../../..
RUN cd server/gst_modules/SrtOpusInput && \
    node-gyp clean && rm -rf build node_modules && node-gyp configure && npm install && cd ../../..
RUN cd server/gst_modules/SrtOpusOutput && \
    node-gyp clean && rm -rf build node_modules && node-gyp configure && npm install && cd ../../..
RUN cd server/gst_modules/SrtVideoPlayer && \
    node-gyp clean && rm -rf build node_modules && node-gyp configure && npm install && cd ../../..
RUN cd server/gst_modules/WhepAudioServer && \
    npm install && npm run build

RUN apt-get -y purge \
    git \
    build-essential \
    libgtk-3-dev \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev

RUN apt -y autoremove

# Default command (override in docker-compose or CLI)
CMD ["bash"]
