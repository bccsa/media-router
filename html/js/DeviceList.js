// ======================================
// Device List client WebApp
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const socket = io(); // Socket.io communication

// -------------------------------------
// DOM objects
// -------------------------------------

const deviceList_header_text = document.getElementById('deviceList_header_text');
const deviceList_control = document.getElementById('deviceList_control');
const deviceList_control_slider = document.getElementById('deviceList_control_slider');

// -------------------------------------
// Global variables & constants
// -------------------------------------

const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const deviceName = deviceList_header_text.textContent;
var isRunning = false;

// -------------------------------------
// socket.io communication
// -------------------------------------

socket.on('connect', () => {
    socket.emit('req_deviceStatus', deviceName);
});

socket.on('deviceStatus', data => {
    isRunning = data.isRunning;

    dom_setRunningStatus();
});

// -------------------------------------
// User events
// -------------------------------------

function deviceList_control_click() {
    isRunning = !isRunning;

    dom_setRunningStatus();

    // Request to change running status
    socket.emit('set_deviceCommand',
    {
        deviceName : deviceName, 
        isRunning : isRunning
    });
}

// Set the ON/OFF control's visible status
function dom_setRunningStatus() {
    if (isRunning) {
        deviceList_control_slider.style.float = "right";
        deviceList_control.style.backgroundColor = "rgb(6, 154, 46)";
    }
    else {
        deviceList_control_slider.style.float = "left";
        deviceList_control.style.backgroundColor = "rgb(34, 75, 18)";
    }
}