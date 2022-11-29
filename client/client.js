var socket = io();
var controls = new uiTopLevelContainer('../controls', 'controls');


// Receive data from router
socket.on('data', data => {
    controls.SetData(data);
});

// Forward data from client UI to router
controls.on('data', data => {
    socket.emit('data', data);
});

