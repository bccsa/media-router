// ======================================
// Dynamic Device List
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { _device } = require('./_device');

// -------------------------------------
// Require device classes
// -------------------------------------

const { AlsaInput } = require('./AlsaInput');
const { AlsaOutput } = require('./AlsaOutput');
const { ffmpegInput } = require('./ffmpegInput');
const { ffplayOutput } = require('./ffplayOutput');
const { RtpInput } = require('./RtpInput');
const { RtpOutput } = require('./RtpOutput');
const { SrtInput } = require('./SrtInput');
const { SrtOutput } = require('./SrtOutput');
const { Mixer } = require('./Mixer');
const { MixerInput } = require('./MixerInput');

// -------------------------------------
// Class declaration
// -------------------------------------

class DeviceList extends _device {
    constructor() {
        super()
        this.name = "Audio Router";
        this.autoStart = false;
        this._list = {};  // List of devices, grouped per device type (class name)
        this.displayOrder = undefined;  // Hide from configuration file
        setTimeout(() => {
            if (this.autoStart == true) {
                this.Start();
            }
        }, 100)
    }

    // List of device classes
    get _deviceTypeList() {
        return {
            // DeviceList,
            AlsaInput,
            AlsaOutput,
            ffmpegInput,
            ffplayOutput,
            RtpInput,
            RtpOutput,
            SrtInput,
            SrtOutput,
            Mixer,
            MixerInput,
        }
    }

    // Create an instance of a device class, and adds the device to the DeviceList.list property
    NewDevice(DeviceType) {
        // Get class
        let c = this._deviceTypeList[DeviceType];

        if (c != undefined) {
            // Create new instance of class
            let d = new c(this);

            // Subscibe to log event
            if (d.log != undefined) {
                d.log.on('log', message => {
                    this._log.emit('log', message);
                });
            }
            else {
                this._logEvent(`Unable subscribe to log event for ${DeviceType}`)
            }

            // Create array for device type, and add to array
            if (this._list[DeviceType] == undefined) {
                this._list[DeviceType] = [];
            }
            this._list[DeviceType].push(d)

            return d;
        }
        else {
            this._logEvent(`Unknown device type "${DeviceType}"`);
        }
    }

    // Create a configuration template JSON object containing one entry per device type.
    GetConfigTemplate() {
        // Create default (template) configuration
        let d = new DeviceList();
        let conf = d.GetConfig();

        // Add configuration for child devices
        Object.keys(this._deviceTypeList).forEach(deviceType => {
            // Get class
            let c = this._deviceTypeList[deviceType];

            // Create new instance of class
            let d = new c(this);

            // Get default configuration, and add to config object
            if (d.GetConfig != undefined) {
                conf.deviceList[deviceType] = [ d.GetConfig() ];
            }
            else {
                this._logEvent(`Unable to get default configuration for ${deviceType}`)
            }
        });
        
        return conf;
    }

    // Creates device instances from the passed configuration JSON object
    SetConfig(config) {
        super.SetConfig(config);

        if (config.deviceList != undefined) {
            Object.keys(config.deviceList).forEach(deviceType => {
                config.deviceList[deviceType].forEach(deviceConfig => {
                    // Create child object, and add to device list
                    let d = this.NewDevice(deviceType);

                    if (d != undefined) {
                        // Set device configuration
                        if (d.SetConfig != undefined) {
                            d.SetConfig(deviceConfig);
                        }
                        else {
                            this._logEvent(`Unable to set device configuration for ${deviceType}`);
                        }
                    }
                    else {
                        this._logEvent(`Unknown device type "${deviceType}"`);
                    }
                    
                });
            });
        }
    }

    // Returns a JSON object with current configuration
    GetConfig() {
        // Add configuration for device list
        let c = super.GetConfig();
        c.deviceList = {};

        // Loop through child devices
        Object.keys(this._list).forEach(deviceType => {
            // Create array for device type
            if (c.deviceList[deviceType] == undefined) {
                c.deviceList[deviceType] = [];
            }

            // Get configuration for each device instance
            this._list[deviceType].forEach(device => {
                if (device.GetConfig != undefined) {
                    c.deviceList[deviceType].push(device.GetConfig());
                }
                else {
                    this._logEvent(`Unable to get configuration for ${deviceType}`);
                }
            });
        });
        
        return c;
    }

    // Find device by device.name property, and returns the device instance
    FindDevice(name) {
        var d = undefined;
        // Loop through devices
        Object.keys(this._list).forEach(deviceType => {
            this._list[deviceType].forEach(device => {
                if (device.name != undefined && device.name == name) {
                    d = device;
                    // +++++++++++++++++++++ To Do: break loop when device is found / use array.find
                }
            });
        });
        return d;
    }

    Start() {
        // Emit run status to subscribed devices in _list
        this.isRunning = true;
    }

    Stop() {
        // Emit run status to subscribed devices in _list
        this.isRunning = false;
    }

    // Generate HTML containing child device iframes
    GetHtml() {
        // Create array of devices with associated html files
        let l = [];
        Object.keys(this._list).forEach(deviceType => {
            this._list[deviceType].forEach(device => {
                if (device.clientHtmlFileName != undefined)
                {
                    l.push(device);
                }
            });
        });
        l.sort(this._deviceListDisplayOrderComparitor);
        
        // Create iframe html
        let iframe = '';
        l.forEach(device => {
            iframe += `<iframe src="${device.clientHtmlFileName}" title="${device.name}" style="width:${device.displayWidth}"></iframe>\n`
        });

        return `<html>
            <head>
                <link rel="stylesheet" href="css/DeviceList.css">
            </head>
            <body>
                <div class="deviceList_header">
                    <span class="deviceList_header_text">${this.name}</span>
                    <span class="deviceList_control_text">OFF</span>
                    <div class="deviceList_control">
                        <div class="deviceList_control_slider"></div>
                    </div>
                    <span class="deviceList_control_text">ON</span>
                </div>
                <div class="deviceList_contents">
                    ${iframe}
                </div>
            </body>
        </html>`
    }

    // Comparitor for sorting the device list according to display order
    _deviceListDisplayOrderComparitor(a,b) {
        if ( a.displayOrder < b.displayOrder ){
            return -1;
          }
          if ( a.displayOrder > b.displayOrder ){
            return 1;
          }
          return 0;
    }
}

// Export class
module.exports.DeviceList = DeviceList;
