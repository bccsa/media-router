// ======================================
// Spacer client WebApp
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// DOM objects
// -------------------------------------

const device_label = document.getElementById('device_label');

// -------------------------------------
// Global variables & constants
// -------------------------------------

const urlParams = new URLSearchParams(window.location.search);
const deviceName = urlParams.get("DeviceName");


// -------------------------------------
// Initial configuration
// -------------------------------------

device_label.textContent = deviceName;
