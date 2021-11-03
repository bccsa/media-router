# audio-translation
Remote audio translation for live events

## Dependencies
### install srt-live-transmit
sudo apt-get -y update
sudo apt-get -y install git
sudo apt-get -y install tclsh
sudo apt-get -y install tcl
sudo apt-get -y install pkg-config
sudo apt-get -y install cmake
sudo apt-get -y install libssl-dev
sudo apt-get -y install build-essential

wget https://github.com/Haivision/srt/archive/refs/tags/v1.4.3.tar.gz
tar -xzf v1.4.3.tar.gz
mv srt-1.4.3/

cd srt-1.4.3/
./configure
make
sudo make install
