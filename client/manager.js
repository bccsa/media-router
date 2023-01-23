var controls = new uiTopLevelContainer('../controls', 'controls');

// Add appFrame control
controls.SetData({
    appFrame: {
        controlType: "appFrame"
    }
});

controls.on('appFrame', appFrame => {
    appFrame.on('login', data => {
        var socket = io({ auth: { username: data.username, password: data.password } });
        // var socket = io({ auth: { username: 'testUser1', password: 'testPass' } });

        socket.on('connect_error', err => {
            console.log('Unable to connect to manager: ' + err.message);
            appFrame._incorrectPassAlert.style.display = "block";
            appFrame._userName.focus();
        });

        socket.on('connect', () => {
            console.log('Connected to manager');
            appFrame.logIn();
            appFrame._disconnectAlert.style.display = "none";
        });

        socket.on('disconnect', () => {
            appFrame.clearControls();
            appFrame._disconnectAlert.style.display = "flex";
        });

        socket.on('data', data => {
            controls.appFrame.SetData(data);
        });

        controls.on('data', data => {
            socket.emit('data', data.appFrame);
        });
    });
});


