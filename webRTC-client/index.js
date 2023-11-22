var socket;
var controls = new uiTopLevelContainer('controls', 'controls');

// Create appframe
controls.Set({
    appFrame: {
        controlType: 'appFrame',
        player1: {
            controlType: 'WebRTCPlayer',
            url: "http://10.9.1.195:8889/test",
            playerName: 'Player 1'
        }
    }
});

controls.on('appFrame', appFrame => {
    // Connect to the Socket.io server when the appFrame is loaded
    socket = io();

    socket.on('connect', () => {
        console.log('connected to manager');
    });

    // socket.on('disconnect', () => {
    //     appFrame.clearControls();
    //     appFrame._disconnectAlert.style.display = "flex";
    //     appFrame._btnAddManager.disabled = true;
    // });
    
    // // Receive data from router
    // socket.on('data', data => {
    //     appFrame.SetData(data);
    // });

    // // Forward data from client UI to router
    // appFrame.on('data', data => {
    //     socket.emit('data', data);
    // });
});
