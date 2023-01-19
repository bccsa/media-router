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
        });

        socket.on('connect', () => {
            console.log('Connected to manager');
            appFrame.logIn();
        });

        socket.on('data', data => {
            controls.appFrame.SetData(data);
        });

        controls.on('data', data => {
            socket.emit('data', data.appFrame);
        });
    });
});


