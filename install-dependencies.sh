sudo apt-get -y update
sudo apt-get -y install nodejs npm
sudo apt-get -y install alsa-utils
sudo apt-get -y install ffmpeg
sudo apt-get -y install git
sudo apt-get -y install tclsh
sudo apt-get -y install tcl
sudo apt-get -y install pkg-config
sudo apt-get -y install cmake
sudo apt-get -y install libssl-dev
sudo apt-get -y install build-essential
sudo apt-get -y install opus-tools

wget https://github.com/Haivision/srt/archive/refs/tags/v1.5.1.tar.gz
tar -xzf v1.5.1.tar.gz


cd srt-1.5.1/
./configure
make
sudo make install

cd ..
rm -r -f srt-1.5.1/
rm -f v1.5.1.tar.gz

git submodule update --init
npm install

cd server
npm install
