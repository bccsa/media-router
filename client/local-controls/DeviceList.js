class DeviceList extends ui {
    constructor() {
        super();
        this.description = "type your description here";
        this.run = false;

        this._styles.push('DeviceList.css');
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <div class="DeviceList_header">
            <span class="DeviceList_header_text">${this.name}</span>
            <span class="DeviceList_control_text">OFF</span>
            <div id="${this._uuid}_control_container" class="DeviceList_control_container">
                <div id="${this._uuid}_control" class="DeviceList_control">
                    <div id="${this._uuid}_control_slider" class="DeviceList_control_slider"></div>
                </div>
            </div>
            <span class="DeviceList_control_text">ON</span>
        </div>
        <div id="${this._uuid}_controls" class="DeviceList_contents"></div>`;
    }

    Init() {
        this._control_container = document.getElementById(`${this._uuid}_control_container`);
        this._control = document.getElementById(`${this._uuid}_control`);
        this._control_slider = document.getElementById(`${this._uuid}_control_slider`);
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);

        // Event subscriptions
        this._control_container.addEventListener("click", () => {
            this.run = !this.run;
            this.NotifyProperty("run");
            // this._setRunningStatus(this.run)
        });
    }

    Update(propertyName) {
        switch (propertyName) {
            case "run":
                this._setRunningStatus(this.run);
            default:
                break;
        }
    }

    _setRunningStatus(run) {
        if (run) {
            this._control_slider.style.float = "right";
            this._control.style.backgroundColor = "rgb(6, 154, 46)";
        }
        else {
            this._control_slider.style.float = "left";
            this._control.style.backgroundColor = "rgb(34, 75, 18)";
        }
    }
}