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
            <button id="@{_btnAddRouter}" class="appFrame-btn-add" type="button" title="Add a new Router"></button>

            <!--    HEADING   -->
            <div class="container-fluid"> <a class="appFrame-heading">Media Router Manager</a></div>

            <!--    LOG OUT BUTTON    -->
            <button id="@{_btnUser}" class="appFrame-btn-log-out" type="button" title="Log in or out"
            data-bs-toggle="modal"  data-bs-target="#@{_modalLogOut}"></button>

        </div> </div>

        

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
                        type="button" data-bs-dismiss="modal"> Log out</button>
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
                    <div class="appFrame-login-alert-text">Incorrect email or password!</div>
                </div>

                <div>
                    <!--    USERNAME INPUT  -->
                    <div class="form-group mb-6">
                        <label for="@{_userName}" class="appFrame-label">Username</label>
                        <input id="@{_userName}" class="appFrame-input-username" type="email"   
                        title="Enter your Username" placeholder="Enter Username" value="testUser1">
                    </div>

                    <!--    PASSWORD INPUT  -->
                    <div class="form-group mb-6">
                        <label for="@{_userPassword}" class="appFrame-label">Password</label>
                        <input id="@{_userPassword}" type="password" class="appFrame-input-password"
                        placeholder="Password" title="Enter your password" value="testPass">
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

        // Set initial values
        let f = this;
        this._incorrectPassAlert.style.display = "none";
        this._disconnectAlert.style.display = "none";
        this._btnAddRouter.disabled = true;
        this._btnUser.disabled = true;

        // Event subscriptions
        this._btnAddRouter.addEventListener('click', (e) => {
            // Get unique random name
            function randomName() {
                return "router_" + Math.round(Math.random() * 10000);
            }
            
            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new router
            this.SetData({[name]: {controlType: "Router"}});
            this.on(name, control => {
                // send newly created router's data to manager
                this._notify({[name]: control.GetData()});

                f.updateOrder();
            });

        });

        this._logOutButton.addEventListener('click', (e) => {
            this.clearControls();
            this._btnAddRouter.disabled = true;
            this._btnUser.disabled = true;
            this._formLogIn.style.display = "flex";
            this._controlsDiv.style.display = "none";
            this._incorrectPassAlert.style.display = "none";
            this._userName.value = "";
            this._userPassword.value = "";
            this._userName.focus();
        });

        this._userRemember.addEventListener('click', (e) => {
            
        });

        this._btnSignIn.addEventListener('click', (e) => {
            this.emit('login', { username: this._userName.value, password: this._userPassword.value  });

        });

        // Save the list order when the router order is changed
        var sortable = Sortable.create(this._controlsDiv, {
            handle: '.router-btn-handel',
            animation: 350,
            chosenClass: "sortable-chosen",
            dragClass: "sortable-drag",
            group: {
                name: 'my-sortable-group'
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

            }
            
        });

        
    }

    // Update the displayOrder property for each control using Sortable js
    updateOrder() {
        var sortable = Sortable.create(this._controlsDiv, {
            handle: '.router-btn-handel',
            animation: 350,
            chosenClass: "sortable-chosen",
            dragClass: "sortable-drag",
            group: {
                name: 'my-sortable-group'
            }
        });

        // Get the ordered list of children elements
        var controlElements = sortable.el.children;

        // Create a list of all the routers
        Object.values(controls.appFrame._controls)

        var controlId
        const router = [];
  
        // Get the ordered list of all the routers
        for (var i = 0; i < controlElements.length; i++) {
          controlId = controlElements[i].id;
          
           router[i] = Object.values(controls.appFrame._controls).find(R => R._uuid == controlId.toString());
           
        }

        // Update the displayOrder property for each control
        for (var i = 0; i < router.length; i++) {
             router[i].displayOrder = i;
          }
    }

    logIn() {
        this._btnAddRouter.disabled = false;
        this._btnUser.disabled = false;
        this._controlsDiv.style.display = "block";
        this._formLogIn.style.display = "none";
        this._incorrectPassAlert.style.display = "none";
    }
      
    clearControls() {
        Object.keys(this._controls).forEach(control => {
            this.RemoveChild(control);
        });
    }

    fadeOut(el) {
        el.style.opacity = 1;
        (function fade() {
            if ((el.style.opacity -= 0.1) < 0) {
                el.style.display = "none";
            } else {
                requestAnimationFrame(fade);
            }
        })();
    }

    fadeIn(el, display) {
        el.style.opacity = 0;
        el.style.display = display || "flex";
        (function fade() {
            let val = parseFloat(el.style.opacity);
            if (!((val += 0.2) > 1)) {
                el.style.opacity = val;
                requestAnimationFrame(fade);
            }
        })();
    }
}
