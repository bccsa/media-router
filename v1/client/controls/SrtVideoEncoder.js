const SVE = require("controls/SrtVideoEncoder/html");

class SrtVideoEncoder extends _uiClasses(_paAudioSinkBase, SrtBase, EncodingSettings) {
    constructor() {
        super();
        // capture
        this.devices = [];
        this.video_device = "/dev/video0";
        this.video_device_descr = "Video0 (disconnected)";
        this.capture_format = "raw";
        this.deinterlace = false;
        // encoder defaults (override mixin)
        this.encoder = "v4l2h264enc";
    }

    get html() {
        return super.html
            .replace(
                "%additionalHtml%",
                `
                ${SVE.html()}
                ${this.EncodingSettingsHtml()}
                ${this.SrtBaseHtml()}
                `
            )
            .replace("<!--  %SrtStatsHtml%  -->", this.SrtStatsHtml());
    }

    Init() {
        super.Init();
        this.setHeaderColor("#00C3A3");

        // init SRT Spesific
        this._SrtInit();

        // update list of video devices
        this.on(
            "devices",
            (devices) => {
                // add new options
                devices.forEach((device) => {
                    let _s = [...this._video_device.options].find(
                        (t) => t.value == device.device
                    );
                    if (!_s) {
                        let o = document.createElement("option");
                        o.value = device.device;
                        o.text = device.name;
                        this._video_device.options.add(o);
                    } else if (_s.value == this.video_device) {
                        _s.text = device.name;
                    }
                });

                // remove invalid options
                [...this._video_device.options].forEach((option) => {
                    let _s = devices.find((t) => t.device == option.value);
                    if (!_s && option.value != this.video_device) {
                        // Remove removed input's && input is not the master input (this is done to avoid input's changing when the device is not connected)
                        this._video_device.options.remove(option.index);
                    } else if (!_s) {
                        // If master is removed, change name to disconnected
                        option.text =
                            this.video_device_descr + " (disconnected)";
                    }
                });

                // Set index / device
                let o = [...this._video_device.options].find(
                    (t) => t.value == this.video_device
                );
                if (o) {
                    this._video_device.selectedIndex = o.index;
                } else {
                    // add video_device to the list, if it is not in the list
                    let o = document.createElement("option");
                    o.value = this.video_device;
                    o.text = this.video_device_descr + " (disconnected)";
                    this._video_device.options.add(o);
                }
            },
            { immediate: true }
        );

        // update saved video device desctiption
        this.on(
            "video_device",
            () =>
                (this.video_device_descr = this.devices.find(
                    (t) => t.device == this.video_device
                ).name)
        );

        // Show/hide x264 speed preset based on encoder selection
        this._EncodingSettingsInit();

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/SrtVideoEncoder.md"); // Load additional MD
        //----------------------Help Modal-----------------------------//
    }
}
