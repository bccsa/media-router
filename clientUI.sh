sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' ~/.config/chromium/'Local State'
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]\+"/"exit_type":"Normal"/' ~/.config/chromium/Default/Preferences
chromium --start-fullscreen --autoplay-policy=no-user-gesture-required  --check-for-update-interval=604800 --disable-extensions http://localhost:8081/client.html