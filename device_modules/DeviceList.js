// ======================================
// Dynamic Device List
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const _device = require('./_device');

// -------------------------------------
// Require device classes
// -------------------------------------

// const { AudioInput } = require('./AudioInput');
// const { AudioOutput } = require('./AudioOutput');
// const { Spacer } = require('./Spacer');
// const { SrtOpusInput } = require('./SrtOpusInput');
// const { SrtOpusOutput } = require('./SrtOpusOutput');

// -------------------------------------
// Class declaration
// -------------------------------------

class DeviceList extends _device {
    constructor() {
        super()
        this.autoStart = false;
        this.autoStartDelay = 500;      // milliseconds
        this.clientControl = "DeviceList";     // This device has an associated client UI control
        this.managerControl = "DeviceList";
        // this.displayOrder = undefined;  // Hide from configuration file
        
        setTimeout(() => {
            if (this.autoStart == true) {
                this.run = true;
            }
        }, this.autoStartDelay)

        // Notify running status
        this.on('run', () => { this.NotifyProperty("run") });
    }
    // // List of device classes
    // get _deviceTypeList() {
    //     return {
    //         AudioInput,
    //         AudioOutput,
    //         Spacer,
    //         SrtOpusInput,
    //         SrtOpusOutput,
    //     }
    // }

    // // Create an instance of a device class, and adds the device to the DeviceList.list property
    // NewDevice(DeviceType) {
    //     // Get class
    //     let c = this._deviceTypeList[DeviceType];

    //     if (c) {
    //         // Create new instance of class
    //         let d = new c(this);

    //         // Subscibe to log event
    //         d.on('log', message => {
    //             this.emit('log', message);
    //         });

    //         // Subscribe to client UI update event
    //         d.on('data', data => {
    //             // Relay events
    //             this.emit('data', data);
    //         });
            
    //         return d;
    //     }
    //     else {
    //         this._logEvent(`Unknown device type "${DeviceType}"`);
    //     }
    // }

    // // Create a configuration template JSON object containing one entry per device type.
    // GetConfigTemplate() {
    //     // Create default (template) configuration
    //     let d = new DeviceList();
    //     let conf = d.GetConfig();

    //     // Add configuration for child devices
    //     Object.keys(this._deviceTypeList).forEach(deviceType => {
    //         // Get class
    //         let c = this._deviceTypeList[deviceType];

    //         // Create new instance of class
    //         let d = new c(this);

    //         // Get default configuration, and add to config object
    //         if (d.GetConfig) {
    //             conf.deviceList[deviceType] = [ d.GetConfig() ];
    //         }
    //         else {
    //             this._logEvent(`Unable to get default configuration for ${deviceType}`)
    //         }
    //     });
        
    //     return conf;
    // }

    // // Creates device instances from the passed configuration JSON object
    // SetConfig(config) {
    //     super.SetConfig(config);

    //     if (config.deviceList) {
    //         Object.keys(config.deviceList).forEach(deviceType => {
    //             config.deviceList[deviceType].forEach(deviceConfig => {
    //                 // Create child object, and add to device list
    //                 let d = this.NewDevice(deviceType);

    //                 if (d) {
    //                     // Set device configuration
    //                     if (d.SetConfig) {
    //                         d.SetConfig(deviceConfig);

    //                         // Create array for device type, and add to array
    //                         if (this._list[deviceType] == undefined) {
    //                             this._list[deviceType] = [];
    //                         }
    //                         this._list[deviceType].push(d);

    //                         // Add to linear list
    //                         if (d.name)
    //                         {
    //                             this._linearList[d.name] = d;
    //                         }
    //                     }
    //                     else {
    //                         this._logEvent(`Unable to set device configuration for ${deviceType}`);
    //                     }
    //                 }
    //                 else {
    //                     this._logEvent(`Unknown device type "${deviceType}"`);
    //                 }
    //             });
    //         });
    //     }
    // }

    // // Returns a JSON object with current configuration
    // GetConfig() {
    //     // Add configuration for device list
    //     let c = super.GetConfig();
    //     c.deviceList = {};

    //     // Loop through child devices
    //     Object.keys(this._list).forEach(deviceType => {
    //         // Create array for device type
    //         if (c.deviceList[deviceType] == undefined) {
    //             c.deviceList[deviceType] = [];
    //         }

    //         // Get configuration for each device instance
    //         this._list[deviceType].forEach(device => {
    //             if (device.GetConfig) {
    //                 c.deviceList[deviceType].push(device.GetConfig());
    //             }
    //             else {
    //                 this._logEvent(`Unable to get configuration for ${deviceType}`);
    //             }
    //         });
    //     });
        
    //     return c;
    // }


    // // Comparitor for sorting the device list according to display order
    // _deviceListDisplayOrderComparitor(a,b) {
    //     if ( a.displayOrder < b.displayOrder ){
    //         return -1;
    //       }
    //       if ( a.displayOrder > b.displayOrder ){
    //         return 1;
    //       }
    //       return 0;
    // }

    // // Get client UI status for given device name
    // GetClientUIstatus(DeviceName) {
    //     if (DeviceName == this.name) {
    //         return {
    //             isRunning : this.isRunning
    //         }
    //     }
    //     else {
    //         if (this._linearList[DeviceName])
    //         {
    //             return this._linearList[DeviceName].GetClientUIstatus();
    //         }
    //     }
    // }

    // // Set client UI command for give device name
    // SetClientUIcommand(clientData) {
    //     if (clientData.deviceName == this.name) {
    //         if (clientData.isRunning) {
    //             if (clientData.isRunning && !this.isRunning) {
    //                 this.Start();
    //             }
    //             else if (!clientData.isRunning && this.isRunning) {
    //                 this._stop();
    //             }
    //         }
    //     }
    //     else {
    //         // Pass command to child device
    //         if (this._linearList[clientData.deviceName]) {
    //             this._linearList[clientData.deviceName].SetClientUIcommand(clientData);
    //         }
    //     }
    // }
}

// Export class
module.exports = DeviceList;
