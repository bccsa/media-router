// ======================================
// Audio Mixer Input client WebApp
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

const device_label                  = document.getElementById('device_label');
const device_control_button         = document.getElementById('device_control_button');
const device_control_button_text    = document.getElementById('device_control_button_text');
const device_volume_slit            = document.getElementById('device_volume_slit');
const device_volume_slider          = document.getElementById('device_volume_slider');
const device_volume_indicator       = document.getElementById('device_volume_indicator');
const device_body                   = document.getElementsByName('body');

// -------------------------------------
// Global variables & constants
// -------------------------------------

const urlParams = new URLSearchParams(window.location.search);
const deviceName = urlParams.get("DeviceName");
var mute = true;
var volume = 1;
var volumeMax = 1.5;
var sliderTop = 0;
var sliderBottom = 0;
var sliderRange = 0;
var sliderActive = false;
var sliderMouseDownPos = 0;
var volumeMouseDownPos = 0;
var muteTimerActive = false;
var volumeTimerActive = false;
var sliderActive = false;

// -------------------------------------
// Initial configuration
// -------------------------------------

device_label.textContent = deviceName;
calcSliderRange();

// -------------------------------------
// socket.io communication
// -------------------------------------

// Request initial device status on connection
socket.on('connect', () => {
    socket.emit('req_deviceStatus', deviceName);
});

// Receive initial device status
socket.on('deviceStatus', data => {
    mute = data.mute;
    volume = data.volume;

    if (!data.showVolumeControl) {
        device_volume_slider.style.display = 'none';
    }

    if (!data.showMuteControl) {
        device_control_button.style.display = 'none';
    }

    dom_setMute();
    dom_setVolume();
});

// Receive device status updates
socket.on('deviceUpdate', data => {
    if (data.mute != undefined) {mute = data.mute}
    if (data.volume != undefined) {volume = data.volume}
    
    dom_setMute();
    dom_setVolume();
});

// Send mute commands to server
function socket_setMute() {
    if (!muteTimerActive && !sliderActive) {
        // Only send data to socket server every 200ms.
        muteTimerActive = true;
        setTimeout(() => {
            socket.emit('set_deviceCommand',
            {
                deviceName : deviceName, 
                mute : mute,
            });
            muteTimerActive = false;
        }, 200);
    }
}

// Send mute commands to server
function socket_setVolume() {
    if (!volumeTimerActive) {
        // Only send data to socket server every 200ms.
        volumeTimerActive = true;
        setTimeout(() => {
            socket.emit('set_deviceCommand',
            {
                deviceName : deviceName, 
                volume : volume,
            });
            volumeTimerActive = false;
        }, 200);
    }
}

// -------------------------------------
// User events
// -------------------------------------

function control_button_click() {
    mute = !mute;

    dom_setMute();
    socket_setMute();
}

// Set the control button's visible status
function dom_setMute() {
    if (mute) {
        device_control_button.style.borderColor = "rgb(6, 154, 46)";
        device_control_button.style.backgroundColor = "rgb(34, 75, 18)";
        device_control_button.style.boxShadow = "0 0 0 0";
        device_control_button_text.textContent = "OFF";
    }
    else {
        device_control_button.style.borderColor = "rgb(12, 255, 77)";
        device_control_button.style.backgroundColor = "rgb(6, 154, 46)";
        device_control_button.style.boxShadow = "0 0 10px 5px rgb(6, 154, 46)";
        device_control_button_text.textContent = "ON";
    }
}

// Detect window resize
onresize = function(e) {
    calcSliderRange();
    dom_setVolume();
}

function calcSliderRange() {
    // Calculate valid slider positions
    sliderTop = device_volume_slit.offsetTop;
    sliderRange = device_volume_slit.offsetHeight - device_volume_slider.offsetHeight;
    sliderBottom = sliderTop + sliderRange;
}

// Calculate volume from slider position
function calcVolume() {
    return volumeMax * (sliderRange - device_volume_slider.offsetTop + device_volume_slit.offsetTop) / sliderRange;
}

// Set volume and send to server
function setVolume() {
    volume = calcVolume();
    socket_setVolume();
}

// Set the volume slider position
function dom_setVolume() {
    if (!sliderActive) {
        device_volume_slider.style.top = `${sliderBottom - volume / volumeMax * sliderRange}px`;
    }
}

// Enable dragging for volume slider
dragElement(device_volume_slider);

// code adapted from https://www.w3schools.com/howto/howto_js_draggable.asp and https://www.kirupa.com/html5/drag.htm
function dragElement(elmnt) {
    var pos1 = 0, pos2 = 0;
    
    //elmnt.onmousedown = dragMouseDown;
    elmnt.addEventListener("touchstart", dragStart, false);
    elmnt.addEventListener("mousedown", dragStart, false);
    
    function dragStart(e) {
        sliderActive = true;
        e = e || window.event;
        e.preventDefault();
        // get the mouse cursor position at startup:
        if (e.type === "touchstart") {
            pos2 = e.touches[0].clientY;
        } else {
            pos2 = e.clientY;
        }

        document.addEventListener("touchend", dragEnd, false);
        document.addEventListener("touchmove", drag, false);
        document.addEventListener("mouseup", dragEnd, false);
        document.addEventListener("mousemove", drag, false);
        document.addEventListener("mouseleave", dragEnd, false);
    }
  
    function drag(e) {
        e = e || window.event;
        if (e.preventDefault) {e.preventDefault()};
        // calculate the new cursor position:
        if (e.type === "touchmove") {
            pos1 = pos2 - e.touches[0].clientY;
            pos2 = e.touches[0].clientY;
        } else {
            pos1 = pos2 - e.clientY;
            pos2 = e.clientY;
        }
        
        // set the element's new position:
        let top = elmnt.offsetTop - pos1;
        if (elmnt.offsetTop - pos1 < sliderTop) { top = sliderTop }
        else if (elmnt.offsetTop - pos1 > sliderBottom) { top = sliderBottom }
        elmnt.style.top = top + "px";
        setVolume();
    }
  
    function dragEnd() {
        sliderActive = false;
        // stop moving when mouse button is released:
        document.removeEventListener("touchend", dragEnd, false);
        document.removeEventListener("touchmove", drag, false);
        document.removeEventListener("mouseup", dragEnd, false);
        document.removeEventListener("mousemove", drag, false);
    }
}