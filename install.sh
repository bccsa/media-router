apt-get -y update
apt-get -y install nodejs npm
apt-get -y install alsa-utils
apt-get -y install ffmpeg
apt-get -y install git
apt-get -y install tclsh
apt-get -y install tcl
apt-get -y install pkg-config
apt-get -y install cmake
apt-get -y install libssl-dev
apt-get -y install build-essential

wget https://github.com/Haivision/srt/archive/refs/tags/v1.4.4.tar.gz
tar -xzf v1.4.4.tar.gz


cd srt-1.4.4/
./configure
make
make install

cd ..
rm -r -f srt-1.4.4/
rm -f v1.4.4.tar.gz
