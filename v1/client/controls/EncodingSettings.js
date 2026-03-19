const ES = require("controls/EncodingSettings/html");

class EncodingSettings {
    constructor() {
        this.encoder = "x264enc";
        this.x264_speed_preset = "ultrafast";
        this.video_bitrate = "2M";
        this.video_gop = 30;
        this.video_quality = 720;
        this.video_framerate = 30;
        this.audio_bitrate = 96;
    }

    /**
     * Returns the shared Encoder Settings + Output Settings HTML
     */
    EncodingSettingsHtml() {
        return ES.html();
    }

    /**
     * Initialise shared encoding UI behaviour (x264 preset show/hide)
     */
    _EncodingSettingsInit() {
        this.on(
            "encoder",
            async () => {
                // wait for element to be ready
                while (!this._x264PresetDiv)
                    await new Promise((res) => setTimeout(res, 100));

                if (this.encoder === "x264enc") {
                    this._x264PresetDiv.style.display = "flex";
                } else {
                    this._x264PresetDiv.style.display = "none";
                }
            },
            { immediate: true }
        );
    }
}
