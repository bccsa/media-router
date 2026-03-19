const { app, BrowserWindow } = require('electron');

const createWindow = () => {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        fullscreen: true,
        // Enable transparency on RPI: https://forums.raspberrypi.com/viewtopic.php?t=262157
        // https://stackoverflow.com/questions/54763647/transparent-windows-on-linux-electron/54784577#54784577
        // Also see https://forums.raspberrypi.com/viewtopic.php?t=308397 to (perhaps) enable transparency using the default window manager
        // Openbox window manager settings: http://openbox.org/wiki/Help:FAQ#How_do_I_get_true_32-bit_transparent_windows.3F
        transparent:true, 
    });
    // Always on top: https://syobochim.medium.com/electron-keep-apps-on-top-whether-in-full-screen-mode-or-on-other-desktops-d7d914579fce
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);

    win.loadFile('index.html')
}

app.whenReady().then(() => {
    createWindow()
});

app.on('window-all-closed', () => {
    app.quit();
});