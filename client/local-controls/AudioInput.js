class AudioInput extends ui {
    constructor() {
        super();
        this.description = "type your description here";
        this._styles.push('AudioInput');
    }

    /*
    "AudioInput": [
      {
        "name": "New Alsa input",
        "channels": 1,
        "sampleRate": 48000,
        "bitDepth": 16,
        "volume": 1,
        "destinations": [
          "Destination device name"
        ],
        "device": "default",
        "bufferSize": 128
      }
       */

    get html() {
        return `
        <!-- ${this.name} -->

        <div id="${this._uuid}_background" class="AudioInput_background">
            <table>
                <tr><td class="AudioInput_label">
                    <div><span id="${this._uuid}_label"></span></div>
                </td></tr>
                <tr><td class="AudioInput_volume">
                    <div id="${this._uuid}_volume_slit" class="AudioInput_volume_slit">
                        <div id="${this._uuid}_peak3" class="AudioInput_peak3"></div>
                        <div id="${this._uuid}_peak2" class="AudioInput_peak2"></div>
                        <div id="${this._uuid}_peak1" class="AudioInput_peak1"></div>
                    </div>
                    <div id="${this._uuid}_volume_slider" class="AudioInput_volume_slider"></div>
                </td></tr>
                <tr><td class="AudioInput_control_button">
                    <div id="${this._uuid}_control_button">
                        <span id="${this._uuid}_control_button_text">OFF</span>
                    </div>
                </td></tr>
            </table>
        </div>`;

    }

    Init() {
        this._label = document.getElementById(`${this._uuid}_label`);
        this._control_button = document.getElementById(`${this._uuid}_control_button`);
        this._control_button_text = document.getElementById(`${this._uuid}_control_button_text`);
        this._volume_slit = document.getElementById(`${this._uuid}_volume_slit`);
        this._volume_slider = document.getElementById(`${this._uuid}_volume_slider`);
        this._volume_indicator = document.getElementById(`${this._uuid}_volume_indicator`);
        this._peak3 = document.getElementById(`${this._uuid}_peak3`);
        this._peak2 = document.getElementById(`${this._uuid}_peak2`);
        this._peak1 = document.getElementById(`${this._uuid}_peak1`);

        // Event subscriptions
        this._control_button.onclick(() => {

        });
    }

    Update(propertyName) {
        switch (propertyName) {
            case "description":
                // this._description.value = this.description;
            default:
                break;
        }
    }


}