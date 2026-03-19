class appFrame extends ui {
    constructor() {
        super();
        this.orderBy = "displayOrder";
        this.build_number = "DEV";
    }

    get html() {
        return `
        <!--    NAV BAR   -->
        <div class="appFrame-top-bar"> <div class="appFrame-top-flex-div">

            <div>
                <!--    ADD BUTTON    -->
                <button id="@{_btnAddRouter}" class="appFrame-btn-add" type="button" title="Add a new Router"></button>

                <!--    Import BUTTON    -->
                <button id="@{_btnImport}" class="appFrame-btn-import ml-2" type="button" title="Import a router"></button>
            </div>

            <!--    HEADING   -->
            <div class="container-fluid"> <a class="appFrame-heading">Media Router Manager</a></div>

            <!--    Manager Configuration    -->
            <button id="@{_manConfig}" class="appFrame-btn-log-out" type="button" title="Manager Configuration"
            data-bs-toggle="modal"  data-bs-target="#@{_modalManConfig}"></button>

        </div> </div>

        <!--    MODAL Manager Config   -->
        <div id="@{_modalManConfig}" class="appFrame-modal-log-out modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm appFrame-modal-dialog">
                <div class="appFrame-modal-content">

                    <div class="appFrame-modal-header">
                        <h5 class="appFrame-modal-heading" > Profile manager</h5>
                        <button id="@{_btnCloseModal}" class="appFrame-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <!--    Build Number     -->
                    <div class="router-container flex grid grid-cols-1 mt-2">
                        <label for="@{_build_number}" class="">Build Number:</label>
                        <div>@{build_number}</div>
                    </div>

                    <div class="appFrame-modal-footer grid grid-cols-2 gap-4 items-stretch">
                        <button class="appFrame-modal-btn-log-out"
                        data-bs-toggle="modal"  data-bs-target="#@{_modalPassword}"> Change Password</button>

                        <button class="appFrame-modal-btn-log-out"
                        data-bs-toggle="modal"  data-bs-target="#@{_modalLogOut}"> Log out</button>

                        <button id="@{_btnExportManagerConfig}" class="appFrame-modal-btn-log-out"> Export Manager</button>
                        <button id="@{_btnImportManagerConfig}" class="appFrame-modal-btn-log-out"> Import Manager</button>
                    </div>
                </div>
            </div>
        </div>

        <!--    MODAL Password   -->
        <div id="@{_modalPassword}" class="appFrame-modal-log-out modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm appFrame-modal-dialog">
                <div class="appFrame-modal-content">

                    <div class="appFrame-modal-header">
                        <h5 class="appFrame-modal-heading" > Change Password </h5>
                        <button id="@{_btnCloseModal}" class="appFrame-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="appFrame-modal-footer grid grid-cols-1 gap-4 items-stretch">
                        <!--    CURRENT PASSWORD  -->
                        <div class="form-group">
                            <label for="@{_txtCurrnetPass}" class="appFrame-label">Current Password</label>
                            <input id="@{_txtCurrnetPass}" type="password" class="appFrame-input-password"
                            placeholder="Current Password" value="">
                            <label id="@{_errCurrentPass}" for="@{_txtCurrnetPass}" class="appFrame-label text-orange-900"></label>
                        </div>

                        <!--    PASSWORD INPUT 1  -->
                        <div class="form-group">
                            <label for="@{_txtPass1}" class="appFrame-label">Enter Password</label>
                            <input id="@{_txtPass1}" type="password" class="appFrame-input-password"
                            placeholder="Enter Password" value="">
                            <label id="@{_errPass1}" for="@{_txtPass1}" class="appFrame-label text-orange-900"></label>
                        </div>

                        <!--    PASSWORD INPUT 2  -->
                        <div class="form-group">
                            <label for="@{_txtPass2}" class="appFrame-label">Retype Password</label>
                            <input id="@{_txtPass2}" type="password" class="appFrame-input-password"
                            placeholder="Retype Password" value="">
                            <label id="@{_errPass2}" for="@{_txtPass2}" class="appFrame-label text-orange-900"></label>
                        </div>

                        <button id="@{_btcChangePass}" class="appFrame-modal-btn-log-out"> Change Password</button>
                    </div>
                </div>
            </div>
        </div>
        

        <!--    DISCONNECT ALERT MESSAGE     -->
        <div id="@{_disconnectAlert}" class="appFrame-disconnect-alert-container">
            <div class="appFrame-disconnect-alert-icon"></div>
            <div class="appFrame-disconnect-alert-text">You have lost connection!</div>
        </div>
      
        <!--    MODAL LOG OUT   -->
        <div id="@{_modalLogOut}" class="appFrame-modal-log-out modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm appFrame-modal-dialog">
                <div class="appFrame-modal-content">

                    <div class="appFrame-modal-header">
                        <div class="appFrame-modal-img"></div>
                        <h5 class="appFrame-modal-heading" > Log out</h5>
                        <button id="@{_btnCloseModal}" class="appFrame-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="appFrame-modal-body">
                        Are you sure you want to log-out?
                    </div>

                    <div class="appFrame-modal-footer">
                        <button id="@{_logOutButton}" class="appFrame-modal-btn-log-out"
                        type="button" data-bs-dismiss="modal"> Yes</button>
                    </div>
                </div>
            </div>
        </div>

        

    
        <!--    LOG IN FORM      -->
        <div id="@{_formLogIn}" class="appFrame-login-form">
            <div class="appFrame-login-container">
            
                <!--    ALERT MESSAGE INCORRECT DETAILS     -->
                <div id="@{_incorrectPassAlert}" class="appFrame-login-alert-container">
                    <div class="appFrame-login-alert-icon"></div>
                    <div class="appFrame-login-alert-text">Incorrect username or password!</div>
                </div>

                <div>
                    <!--    USERNAME INPUT  -->
                    <div class="form-group mb-6">
                        <label for="@{_userName}" class="appFrame-label">Username</label>
                        <input id="@{_userName}" class="appFrame-input-username" type="email"   
                        title="Enter your Username" placeholder="Enter Username" value="admin" disabled readonly>
                    </div>

                    <!--    PASSWORD INPUT  -->
                    <div class="form-group mb-6">
                        <label for="@{_userPassword}" class="appFrame-label">Password</label>
                        <input id="@{_userPassword}" type="password" class="appFrame-input-password"
                        placeholder="Password" title="Enter your password" value="">
                    </div>
                    
                    <div class="appFrame-login-flex-div">

                        <!--     REMEMBER ME CHECKBOX    -->
                        <div class="form-group form-check" title="Check this to remember log in details">
                            <input id="@{_userRemember}" class="appFrame-checkbox" type="checkbox">
                            <label for="@{_userRemember}" class="appFrame-label-remember" >Remember me</label>
                        </div>

                        <!--    FORGOT PASSWORD LINK    -->
                        <a href="#!" class="appFrame-link-forgot-pass">Forgot password?</a>
                    </div>

                    <!--    SIGN IN BUTTON    -->
                    <button id="@{_btnSignIn}" class="appFrame-btn-sign-in" title="Click to sign in" >Sign in</button>

                </div>
            </div>
        </div> 

        <!--    ROUTER     -->
        <div id="@{_controlsDiv}" class="list-group appFrame-controls-div"></div>
        `;
    }

    Init() {
        // --------------------------
        // change password
        // --------------------------
        // event listeners
        this._txtPass2.addEventListener("input", (e) => {
            if (this._txtPass1.value == this._txtPass2.value)
                this._errPass2.innerHTML = "";
            else this._errPass2.innerHTML = "Password's does not match";
        });

        this._btcChangePass.addEventListener("click", (e) => {
            if (this._txtPass1.value == this._txtPass2.value) {
                let data = {
                    currentPass: this._txtCurrnetPass.value,
                    newPass: this._txtPass1.value,
                };
                this.emit("change_password", data, "top");
            }
        });

        this.on("new_password", (data) => {
            if (data) {
                console.log("Password updated");
                this._errCurrentPass.innerHTML =
                    "Password updated successfully";
            } else
                this._errCurrentPass.innerHTML = "Current password is invalid";
        });

        // --------------------------
        // Other
        // --------------------------
        // Set initial values
        let f = this;
        this._incorrectPassAlert.style.display = "none";
        this._disconnectAlert.style.display = "none";
        this._btnAddRouter.disabled = true;
        this._manConfig.disabled = true;

        // Event subscriptions
        this._btnAddRouter.addEventListener("click", (e) => {
            // Get unique random name
            function randomName() {
                return "router_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new router
            this.SetData({ [name]: { controlType: "Router" } });
            this.on(name, (control) => {
                // send newly created router's data to manager
                this._notify({ [name]: control.GetData() });

                f.updateOrder();
            });
        });

        this._logOutButton.addEventListener("click", (e) => {
            this.clearControls();
            this._btnAddRouter.disabled = true;
            this._manConfig.disabled = true;
            this._formLogIn.style.display = "flex";
            this._controlsDiv.style.display = "none";
            this._incorrectPassAlert.style.display = "none";
            this._userPassword.value = "";
            this._userName.focus();
            // clear localStorage
            localStorage.removeItem("username");
            localStorage.removeItem("password");
            // disconnect socket
            this.emit("disconnect", true, "top");
        });

        this._userRemember.addEventListener("click", (e) => {});

        this._btnSignIn.addEventListener("click", (e) => {
            this.emit("login", {
                username: this._userName.value,
                password: this._userPassword.value,
            });
        });

        // Save the list order when the router order is changed
        var sortable = Sortable.create(this._controlsDiv, {
            handle: ".router-btn-handel",
            animation: 350,
            chosenClass: "sortable-chosen",
            dragClass: "sortable-drag",
            group: {
                name: "my-sortable-group",
            },

            store: {
                /**
                 * Save the order of elements. Called onEnd (when the item is dropped).
                 * @param {Sortable}  sortable
                 */
                set: function (sortable) {
                    // Update the displayOrder property for each Router
                    f.updateOrder();
                },
            },
        });

        // ======================= Import / Export =======================
        // Import a single router from a file
        this._btnImport.addEventListener("click", (e) => {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = ".mr";
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (e) => {
                    const data = JSON.parse(e.target.result);
                    loadRouter(data);
                };
                reader.readAsText(file);
            };
            fileInput.click();
        });

        // Create an export of all the manager configuration
        this._btnExportManagerConfig.addEventListener("click", (e) => {
            const data = this.GetData({ sparse: false });
            const controls = [];
            Object.values(data).forEach((control) => {
                if (control.controlType == "Router") {
                    delete control.online;
                    delete control.run;
                    control.cpuUsage = 0;
                    control.cpuTemperature = 0;
                    control.memoryUsage = 0;
                    controls.push(control);
                }
            });
            const blob = new Blob([JSON.stringify(controls)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "manager_config.mrm";
            a.click();
        });

        // Import a manager configuration from a file
        this._btnImportManagerConfig.addEventListener("click", (e) => {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = ".mrm";
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (e) => {
                    const data = JSON.parse(e.target.result);
                    data.forEach((control) => {
                        loadRouter(control);
                    });
                };
                reader.readAsText(file);
            };
            fileInput.click();
        });

        const loadRouter = (data) => {
            const name = data.name;
            this.SetData({ [name]: data });
            this._notify({ [name]: data });

            this.once(name, () => {
                f.updateOrder();
            });
        };
        // ======================= Import / Export =======================
    }

    // Update the displayOrder property for each control using Sortable js
    updateOrder() {
        var sortable = Sortable.create(this._controlsDiv, {
            handle: ".router-btn-handel",
            animation: 350,
            chosenClass: "sortable-chosen",
            dragClass: "sortable-drag",
            group: {
                name: "my-sortable-group",
            },
        });

        // Get the ordered list of children elements
        var controlElements = sortable.el.children;

        // Create a list of all the routers
        Object.values(controls.appFrame._controls);

        var controlId;
        const router = [];

        // Get the ordered list of all the routers
        for (var i = 0; i < controlElements.length; i++) {
            controlId = controlElements[i].id;

            router[i] = Object.values(controls.appFrame._controls).find(
                (R) => R._uuid == controlId.toString()
            );
        }

        // Update the displayOrder property for each control
        for (var i = 0; i < router.length; i++) {
            router[i].displayOrder = i;
        }
    }

    logIn() {
        this._btnAddRouter.disabled = false;
        this._manConfig.disabled = false;
        this._controlsDiv.style.display = "block";
        this._formLogIn.style.display = "none";
        this._incorrectPassAlert.style.display = "none";
    }

    clearControls() {
        Object.keys(this._controls).forEach((control) => {
            this.RemoveChild(control);
        });
    }
}
