var socket;
var controls = new uiTopLevelContainer('controls', 'controls');

// Create appframe
controls.Set({
    appFrame: {
        controlType: 'appFrame'
    }
});

controls.on('appFrame', appFrame => {
    // Connect to the Socket.io server when the appFrame is loaded
    socket = io();

    socket.on('connect', () => {
        appFrame._disconnectAlert.style.display = "none";
        appFrame._btnAddManager.disabled = false;
    });

    socket.on('disconnect', () => {
        appFrame.clearControls();
        appFrame._disconnectAlert.style.display = "flex";
        appFrame._btnAddManager.disabled = true;
    });
    
    // Receive data from router
    socket.on('data', data => {
        appFrame.SetData(data);
    });

    // Forward data from client UI to router
    appFrame.on('data', data => {
        socket.emit('data', data);
    });
});
