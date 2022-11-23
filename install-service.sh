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