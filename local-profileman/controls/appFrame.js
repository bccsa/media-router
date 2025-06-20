class appFrame extends ui {
    constructor() {
        super();
        this.orderBy = 'displayOrder';
        this.envFile = "VAL1=1\nVAL2=2\nVAL3=3";
        this.envFileErr = "";
    }

    get html() {
        return `
        <!--    NAV BAR   -->
        <div class="appFrame-top-bar"> <div class="appFrame-top-flex-div">

            <!--    ONLINE/OFFLINE -->
            <span id="@{_online}" class="badge_online">
            <span class="badge_online_dot"></span>
            Online
            </span>

            <span id="@{_offline}" class="badge_offline">
            <span class="badge_offline_dot"></span>
            Offline
            </span>

            <div class="flex items-center">
                <!--    ADD BUTTON    -->
                <button id="@{_btnAddManager}" class="appFrame-btn-add" type="button" title="Add a new manager profile"></button>

                <!--    ENV Editor BUTTON    -->
                <button id="@{_btnOpenEnvEditor}" class="appFrame-btn-env ml-4" type="button" title="Open ENV editor"></button>
            </div>

            <!--    HEADING   -->
            <div class="container-fluid"> <a class="appFrame-heading">Media Router Profile Manager</a></div>

            <!--    LOG OUT BUTTON    -->
            <button id="@{_btnUser}" class="appFrame-btn-log-out" type="button" title=""></button>

        </div>

        <!--    DISCONNECT ALERT MESSAGE     -->
        <div id="@{_disconnectAlert}" class="appFrame-disconnect-alert-container">
            <div class="appFrame-disconnect-alert-icon"></div>
            <div class="appFrame-disconnect-alert-text">You have lost connection!</div>
        </div>

        <!--    Profiles     -->
        <div id="@{_controlsDiv}" class="appFrame_contents">
        
        </div>

        <!-- The Modal -->
        <div id="@{myModal}" class="env-modal">

            <!-- Modal content -->
            <div class="env-modal-content">
                <div class="env-modal-header flex justify-between items-center">
                    <button id="@{_btnHelpEnvEditor}" class="appFrame-btn-help ml-4" type="button" title="Help"></button>
                    <h2 class="text-lg text-bold">ENV File Editor</h2>
                    <button id="@{_btnCloseEnvEditor}" class="appFrame-btn-exit ml-4" type="button" title="Close ENV editor"></button>
                </div>
                
                <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-4"></div>

                <div id="@{_envBody}" class="env-modal-body">
                    <!--    ENV File location      -->
                    <div class="text-black">
                        <label for="@{_envFile}" class="mb-2 text-white">ENV File: </label>
                        <textarea id="@{_envFile}" rows="5" class="text-black w-full p-2" value="@{envFile}"></textarea>
                    </div>

                    <label class="text-red-400 text-xl">@{envFileErr}</label>
                </div>

                <!-- Help -->
                <div id="@{_envHelp}" class="env-modal-body hidden prose prose-slate text-white">
                    
                </div>

            </div>

        </div>

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

        //----------------------------
        // ENV Editor

        this._btnOpenEnvEditor.addEventListener('click', (e) => {
            this.myModal.style.display = "block";
            this._envHelp.style.display = "none";
            this._envBody.style.display = "block";
        })

        // When the user clicks anywhere outside of the modal, close it
        window.addEventListener('click', (e) => {
            if (e.target == this.myModal) {
                this.myModal.style.display = "none";
            }
        })

        // Close BTN 
        this._btnCloseEnvEditor.addEventListener('click', (e) => {
            this.myModal.style.display = "none";
        })

        // Help BTN 
        this._btnHelpEnvEditor.addEventListener('click', (e) => {
            if (this._envHelp.style.display == "block") {
                this._envHelp.style.display = "none";
                this._envBody.style.display = "block";
            } else {
                this._envHelp.style.display = "block";
                this._envBody.style.display = "none";
            }
        })

        // Disable ENV Edidtor if there is a error with loading the env file
        this.on("envFileErr", e => {
            if (e != "") { this._envFile.disabled = true } 
            else { this._envFile.disabled = false }
        }, { immediate: true });
        
        // ENV Editor
        //----------------------------

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadMD('controls/envFileEditor.md')
        .then(res => {
            this._envHelp.innerHTML = res;
        });
        //----------------------Help Modal-----------------------------//
    }

    _loadMD(_path) {
        return new Promise((resolve, reject) => {
            fetch(_path)
            .then((response) => {
                if (!response.ok) { throw new Error('Network response was not ok') }
                return response.text();
            })
            .then((fileContent) => {
                let converter = new showdown.Converter();
                let html = converter.makeHtml(fileContent); 
                resolve(html);
            })
            .catch((error) => { console.error('There was a problem fetching the file:', error); resolve(""); });
        })
    }

    clearControls() {
        Object.keys(this._controls).forEach(control => {
            this.RemoveChild(control);
        });
    }
    /**
     * Check if device is online or offline
     */
    setOnline(manager_online) {
        if (manager_online) {
            this._online.style.display = "inline-flex";
            this._offline.style.display = "none";
        } else {
            this._online.style.display = "none";
            this._offline.style.display = "inline-flex";
        }
    }
}

