class _paAudioBase extends ui {
    constructor() {
        super();
        // this._styles.push('_paAudioBase.css');
        this.displayName = '';
        this.mute = false;
        this.volume = 1;
        this.maxVolume = 1.5;
        this.showVolumeControl = true;  // Show volume slider on local client
        this.showMuteControl = true;    // Show mute button on local client
        this.showControl = true;        // show control on local client
        this.vuData = 0;
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
        this._lastDragUpdate = 0;
        this._sliderRaf = null;
        this._pendingSliderTop = null;
        this._dragEmitInterval = 150;
        this.displayOrder = 0;
    }

    get html() {
        return `
        <div class="paAudioBase_background">
            <table>

                <tr><td class="paAudioBase_label">
                    <div><span>@{displayName}</span></div>
                </td></tr>

                <tr><td class="paAudioBase_volume">
                    <div id="@{_volume_slit}" class="paAudioBase_volume_slit">
                    </div>
                    <div id="@{_volume_slider}" class="paAudioBase_volume_slider"></div>
                </td></tr>

                <tr><td class="paAudioBase_control_button">
                    <div id="@{_control_button}" title="Mute button">
                        <span id="@{_control_button_text}">OFF</span>
                    </div>
                </td></tr>

            </table>
        </div>`;
    }

    Init() {
        // this._control_button = document.getElementById(`@{_control_button`);
        // this._control_button_text = document.getElementById(`@{_control_button_text`);
        // this._volume_slit = document.getElementById(`@{_volume_slit`);
        // this._volume_slider = document.getElementById(`@{_volume_slider`);

        // Set show mute control
        this._showMuteControl();
        this._showSliderControl();

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
        this.Set({
            vu: {
                controlType: "VuMeter",
                hideData: true,
                parentElement: `_volume_slit`,
            }
        });

        // Handle property changes
        this.on('mute', () => {
            this._setMute();
        }, { immediate: true });

        this.on('volume', () => {
            this._setVolume();
        });

        this.on('vuData', level => {
            if (this.vu) {
                this.vu.level = level;
            }
        });

        this.on('showVolumeControl', () => {
            this._showSliderControl();
        });

        this.on('showMuteControl', () => {
            this._showMuteControl();
        });

        // Workaround: calculate initial slider range after css is applied
        setTimeout(() => {
            this._calcSliderRange();
            this._setVolume();
        }, 100);

    }

    _setMute() {
            if (this.mute) {
                // mute
                this._control_button.style.borderColor = "rgb(6, 154, 46)";
                this._control_button.style.backgroundColor = "rgb(34, 75, 18)";
                this._control_button.style.boxShadow = "0 0 0 0";
                this._control_button_text.textContent = "OFF";
            }
            else {
                // unmute
                this._control_button.style.borderColor = "rgb(12, 255, 77)";
                this._control_button.style.backgroundColor = "rgb(6, 154, 46)";
                this._control_button.style.boxShadow = "0 0 10px 5px rgb(6, 154, 46)";
                this._control_button_text.textContent = "ON";
            }
    }

    _showMuteControl() {
        if (this.showMuteControl) {
            this._control_button.style.visibility = "visible";
        }
        else {
            this._control_button.style.visibility = "hidden";
        }
    }

    _showSliderControl() {
        if (this.showVolumeControl) {
            this._volume_slider.style.visibility = "visible";
        }
        else {
            this._volume_slider.style.visibility = "hidden";
        }
    }

    _setVolume() {
        if (this._sliderActive) {
            return;
        }
        this._volume_slider.style.top = this._sliderTop + this._sliderRange - this._sliderRange * this.volume / this.maxVolume + "px";
    }

    _calcSliderRange() {
        // Calculate valid slider positions
        this._sliderTop = this._volume_slit.offsetTop;
        this._sliderRange = this._volume_slit.offsetHeight - this._volume_slider.offsetHeight;
        this._sliderBottom = this._sliderTop + this._sliderRange;
    }

    // Calculate volume from slider position
    _calcVolume(topOverride) {
        const sliderTop = topOverride !== undefined ? topOverride : this._volume_slider.offsetTop;
        this.volume = this._volumeFromTop(sliderTop);
    }

    _volumeFromTop(top) {
        if (!this._sliderRange) {
            return this.volume;
        }

        const relative = Math.min(Math.max(top - this._sliderTop, 0), this._sliderRange);
        return this.maxVolume * (this._sliderRange - relative) / this._sliderRange;
    }

    _scheduleSliderRender(top) {
        const hasRaf = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
        if (!hasRaf) {
            this._volume_slider.style.top = `${top}px`;
            this._pendingSliderTop = null;
            return;
        }

        this._pendingSliderTop = top;
        if (!this._sliderRaf) {
            this._sliderRaf = window.requestAnimationFrame(() => {
                this._sliderRaf = null;
                if (this._pendingSliderTop !== null) {
                    this._volume_slider.style.top = `${this._pendingSliderTop}px`;
                    this._pendingSliderTop = null;
                }
            });
        }
    }

    _flushSliderRender() {
        const hasCancel = typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function";
        if (this._sliderRaf && hasCancel) {
            window.cancelAnimationFrame(this._sliderRaf);
        }
        this._sliderRaf = null;
        if (this._pendingSliderTop !== null) {
            this._volume_slider.style.top = `${this._pendingSliderTop}px`;
            this._pendingSliderTop = null;
        }
    }

    // Enable dragging of slider
    // code adapted from https://www.w3schools.com/howto/howto_js_draggable.asp and https://www.kirupa.com/html5/drag.htm
    _dragElement(elmnt, caller) {
        let lastClientY = 0;
        let currentTop = 0;
        const updateInterval = caller._dragEmitInterval;

        elmnt.addEventListener("touchstart", dragStart, false);
        elmnt.addEventListener("mousedown", dragStart, false);

        function dragStart(e) {
            caller._sliderActive = true;
            e = e || window.event;
            e.preventDefault();
            // get the mouse cursor position at startup:
            if (e.type === "touchstart") {
                lastClientY = e.touches[0].clientY;
            } else {
                lastClientY = e.clientY;
            }

            caller._calcSliderRange();
            currentTop = elmnt.offsetTop;
            caller._pendingSliderTop = currentTop;
            caller._lastDragUpdate = 0;

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
            let clientY;
            if (e.type === "touchmove") {
                clientY = e.touches[0].clientY;
            } else {
                clientY = e.clientY;
            }

            const deltaY = lastClientY - clientY;
            lastClientY = clientY;

            // calculate the element's new position:
            let top = currentTop - deltaY;
            if (top < caller._sliderTop) { top = caller._sliderTop }
            else if (top > caller._sliderBottom) { top = caller._sliderBottom }

            if (top !== currentTop) {
                currentTop = top;
                caller._scheduleSliderRender(currentTop);
            }

            const now = window.performance && window.performance.now ? window.performance.now() : Date.now();
            if (now - caller._lastDragUpdate >= updateInterval) {
                caller._lastDragUpdate = now;
                caller._calcVolume(currentTop);
            }
        }

        function dragEnd() {
            caller._sliderActive = false;
            // stop moving when mouse button is released:
            document.removeEventListener("touchend", dragEnd, false);
            document.removeEventListener("touchmove", drag, false);
            document.removeEventListener("mouseup", dragEnd, false);
            document.removeEventListener("mousemove", drag, false);
            
            // Always apply final position on drag end
            caller._flushSliderRender();
            if (currentTop < caller._sliderTop) { currentTop = caller._sliderTop; }
            else if (currentTop > caller._sliderBottom) { currentTop = caller._sliderBottom; }
            caller._calcVolume(currentTop);
            caller._lastDragUpdate = 0;
        }
    }
}