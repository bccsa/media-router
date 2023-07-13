class appFrame extends ui {
    constructor() {
        super();
        this.orderBy = 'displayOrder';
    }

    get html() {
        return `
        <!--    NAV BAR   -->
        <div class="appFrame-top-bar"> <div class="appFrame-top-flex-div">

            <!--    ADD BUTTON    -->
            <button id="@{_btnAddManager}" class="appFrame-btn-add" type="button" title="Add a new Manager"></button>

            <!--    HEADING   -->
            <div class="container-fluid"> <a class="appFrame-heading">Set Manager</a></div>

            <!--    LOG OUT BUTTON    -->
            <button id="@{_btnUser}" class="appFrame-btn-log-out" type="button" title=""></button>

        </div> </div>

        <!--    DISCONNECT ALERT MESSAGE     -->
        <div id="@{_disconnectAlert}" class="appFrame-disconnect-alert-container">
            <div class="appFrame-disconnect-alert-icon"></div>
            <div class="appFrame-disconnect-alert-text">You have lost connection!</div>
        </div>

        <!--    Manager     -->
        <div id="@{_controlsDiv}" class="appFrame_contents"></div>

        `;
    }

    Init() {

        // Set initial values
        let f = this;
        
        this._disconnectAlert.style.display = "none";

        // Event subscriptions
        this._btnAddManager.addEventListener('click', (e) => {
            // Get unique random name
            function randomName() {
                return "managerPanel_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new manager
            this.Set({ [name]: { controlType: "managerPanel" } });
            this.on(name, control => {
                // send newly created manager's data to manager
                this._notify({ [name]: control.GetData() });
            });

        });
    }

    clearControls() {
        Object.keys(this._controls).forEach(control => {
            this.RemoveChild(control);
        });
    }

}
