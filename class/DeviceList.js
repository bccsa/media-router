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

// -------------------------------------
// Class declaration
// -------------------------------------

class DeviceList extends _device {
    constructor() {
        super()
        this.name = "Audio Router";
        this.autoStart = false;
        this._list = {};  // List of devices, grouped per device type (class name)

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
        }
    }

    // Create an instance of a device class, and adds the device to the DeviceList.list property
    NewDevice(DeviceType) {
        // Get class
        let c = this._deviceTypeList[DeviceType];

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

                    // Set device configuration
                    if (d.SetConfig != undefined) {
                        d.SetConfig(deviceConfig);
                    }
                    else {
                        this._logEvent(`Unable to set device configuration for ${deviceType}`);
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
}

// Export class
module.exports.DeviceList = DeviceList;
