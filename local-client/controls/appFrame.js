class appFrame extends ui {
    constructor() {
        super();
        this.displayName = '';
        this.run = false;
        this._styles.push('appFrame.css');
        this.orderBy = 'displayOrder';
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <div class="appFrame_header">
            <span class="appFrame_header_text">@{displayName}</span>
            <span class="appFrame_control_text">OFF</span>
            <div id="@{_control_container}" class="appFrame_control_container">
                <div id="@{_control}" class="appFrame_control">
                    <div id="@{_control_slider}" class="appFrame_control_slider"></div>
                </div>
            </div>
            <span class="appFrame_control_text">ON</span>
        </div>
        <div id="@{_controlsDiv}" class="appFrame_contents"></div>`;
    }

    Init() {
        // Event subscriptions
        this._control_container.addEventListener("click", () => {
            this.run = !this.run;
            this.NotifyProperty('run');
        });

        this.on('run', run => {
            if (run) {
                this._control_slider.style.float = "right";
                this._control.style.backgroundColor = "rgb(6, 154, 46)";
            }
            else {
                this._control_slider.style.float = "left";
                this._control.style.backgroundColor = "rgb(34, 75, 18)";
            }
        }, { immediate: true });

        // Only show controls where the showControl property is set
        this.filter(c => c.showControl);
    }
}