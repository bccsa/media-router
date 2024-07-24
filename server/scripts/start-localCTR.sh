# Start local control panel

#################################
#
# This is a example script, replace yo work for your distro / build
#
#################################

# Get the platform
platform=$(dpkg --print-architecture | xargs)
# Get the OS codename
oscode=$(lsb_release -a|grep Codename|cut -f2 -d':' | xargs)


# ----------------------------------------
# Bullseye / Bookworm
# ----------------------------------------
if [ "$oscode" == "bullseye" ] || [ "$oscode" == "bookworm" ]; then 
    # Start the local client in a full-screen (kiosk mode) chromium browser window.
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' ~/.config/chromium/'Local State'
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]\+"/"exit_type":"Normal"/' ~/.config/chromium/Default/Preferences
    chromium-browser --start-maximized --start-fullscreen --autoplay-policy=no-user-gesture-required  --check-for-update-interval=604800 --disable-extensions http://localhost:8081
# ----------------------------------------
# Noble
# ----------------------------------------
elif [ "$oscode" == "noble" ]; then
    # Start the local client in a full-screen (kiosk mode) chromium browser window.
    # --test-type: https://stackoverflow.com/questions/44429624/chromium-headless-remove-no-sandbox-notification
    # --window-size: https://unix.stackexchange.com/questions/273989/how-can-i-make-chromium-start-full-screen-under-x
    DISPLAY=:0.0 xinit /bin/chromium-browser --test-type --no-sandbox --start-maximized --start-fullscreen --kiosk --autoplay-policy=no-user-gesture-required  --check-for-update-interval=604800 --window-size=1920,1080 --window-position=0,0 --disable-extensions http://localhost:8081 
fi