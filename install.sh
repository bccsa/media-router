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

wget https://github.com/Haivision/srt/archive/refs/tags/v1.4.4.tar.gz
tar -xzf v1.4.4.tar.gz


cd srt-1.4.4/
./configure
make
sudo make install

cd ..
rm -r -f srt-1.4.4/
rm -f v1.4.4.tar.gz

git submodule update --init
npm install

echo "[Unit]
Description=Media Router
After=network.target

[Service]
WorkingDirectory=$PWD
ExecStart=$PWD/router.sh
User=$USER
Group=$USER
Restart=always

[Install]
WantedBy=multi-user.target
" | sudo tee /lib/systemd/system/media-router.service

chmod +x router.sh
sudo systemctl daemon-reload
sudo systemctl enable media-router
sudo systemctl restart media-router

echo "@sh $PWD/clientUI.sh" | sudo tee --append /etc/xdg/lxsession/LXDE-pi/autostart