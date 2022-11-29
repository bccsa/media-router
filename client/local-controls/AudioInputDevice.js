class AudioInputDevice extends ui {
    constructor() {
        super();
        this.description = "type your description here";
        this._styles.push('AudioInputDevice.css');

        this.mute = true;
        this.volume = 1;
        this.maxVolume = 1.5;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.level = 0;
        this.peak = 0;
        this._sliderTop = 0;
        this._sliderBottom = 0;
        this._sliderRange = 0;
        this._sliderActive = false;
        this._sliderMouseDownPos = 0;
        this._volumeMouseDownPos = 0;
        this._muteTimerActive = false;
        this._volumeTimerActive = false;
        this._sliderActive = false;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <div class="AudioInputDevice_background">
            <table>
                <tr><td class="AudioInputDevice_label">
                    <div><span>${this.name}</span></div>
                </td></tr>
                <tr><td class="AudioInputDevice_volume">
                    <div id="${this._uuid}_volume_slit" class="AudioInputDevice_volume_slit">
                    </div>
                    <div id="${this._uuid}_volume_slider" class="AudioInputDevice_volume_slider"></div>
                </td></tr>
                <tr><td class="AudioInputDevice_control_button">
                    <div id="${this._uuid}_control_button">
                        <span id="${this._uuid}_control_button_text">OFF</span>
                    </div>
                </td></tr>
            </table>
        </div>`;

    }

    Init() {
        // this._label = document.getElementById(`${this._uuid}_label`);
        this._control_button = document.getElementById(`${this._uuid}_control_button`);
        this._control_button_text = document.getElementById(`${this._uuid}_control_button_text`);
        this._volume_slit = document.getElementById(`${this._uuid}_volume_slit`);
        this._volume_slider = document.getElementById(`${this._uuid}_volume_slider`);

        // Workaround: calculate slider range after css is applied
        setTimeout(() => { this._calcSliderRange() }, 100);

        // Enable dragging for volume slider
        this._dragElement(this._volume_slider, this);

        // Event subscriptions
        this._control_button.addEventListener('click', (e) => {
            this.mute = !this.mute;

            this._setMute();
            this.NotifyProperty("mute");
        });

        // recalculate volume slider range on window resize
        window.addEventListener('resize', e => {
            this._calcSliderRange();
            this._setVolume();
        });

        // Add VU meter
        this.SetData({
            vu: {
                controlType: "VuMeter",
                hideData: true,
                parentElement: `_volume_slit`,
            }
        });
    }

    Update(propertyName) {
        switch (propertyName) {
            case "mute":
                this._setMute();
                break;
            case "volume":
                this._setVolume();
                break;
            case "level":
                if (this.vu) {
                    // this.SetData({
                    //     vu: { 
                    //         level: this.level
                    //     }
                    // });
                }
                break;
            default:
                break;
        }
    }

    _setMute() {
        if (this.mute) {
            this._control_button.style.borderColor = "rgb(6, 154, 46)";
            this._control_button.style.backgroundColor = "rgb(34, 75, 18)";
            this._control_button.style.boxShadow = "0 0 0 0";
            this._control_button_text.textContent = "OFF";
        }
        else {
            this._control_button.style.borderColor = "rgb(12, 255, 77)";
            this._control_button.style.backgroundColor = "rgb(6, 154, 46)";
            this._control_button.style.boxShadow = "0 0 10px 5px rgb(6, 154, 46)";
            this._control_button_text.textContent = "ON";
        }
    }

    _setVolume() {
        if (!this._sliderActive) {
            this._volume_slider.style.top = `${this._sliderBottom - this.volume / this.maxVolume * this._sliderRange}px`;
        }
    }

    _calcSliderRange() {
        // Calculate valid slider positions
        this._sliderTop = this._volume_slit.offsetTop;
        this._sliderRange = this._volume_slit.offsetHeight - this._volume_slider.offsetHeight;
        this._sliderBottom = this._sliderTop + this._sliderRange;
    }

    // Calculate volume from slider position
    _calcVolume() {
        this.volume = this.maxVolume * (this._sliderRange - this._volume_slider.offsetTop + this._volume_slit.offsetTop) / this._sliderRange;
    }

    // Enable dragging of slider
    // code adapted from https://www.w3schools.com/howto/howto_js_draggable.asp and https://www.kirupa.com/html5/drag.htm
    _dragElement(elmnt, caller) {
        let pos1 = 0, pos2 = 0;

        elmnt.addEventListener("touchstart", dragStart, false);
        elmnt.addEventListener("mousedown", dragStart, false);

        function dragStart(e) {
            caller._sliderActive = true;
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
            if (e.preventDefault) { e.preventDefault() };
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
            if (elmnt.offsetTop - pos1 < caller._sliderTop) { top = caller._sliderTop }
            else if (elmnt.offsetTop - pos1 > caller._sliderBottom) { top = caller._sliderBottom }
            elmnt.style.top = top + "px";

            caller._calcVolume();
            // caller._setVolume();
            caller.NotifyProperty('volume');
        }

        function dragEnd() {
            caller._sliderActive = false;
            // stop moving when mouse button is released:
            document.removeEventListener("touchend", dragEnd, false);
            document.removeEventListener("touchmove", drag, false);
            document.removeEventListener("mouseup", dragEnd, false);
            document.removeEventListener("mousemove", drag, false);
        }
    }
}