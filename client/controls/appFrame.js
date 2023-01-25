class appFrame extends ui {
    constructor() {
        super();
    }

    get html() {
        return `
        <!-- Nav bar  -->
        <nav class="appFrame-top-bar">
            <div class="appFrame-top-flex-div">
                <!-- Add Button  -->
                <button id="@{_addButton}" type="button" class="appFrame-btn-add"
                    title="Add a new DeviceList">
                </button>

                <!-- Heading  -->
                <div class="container-fluid">
                    <a class="appFrame-heading" href="#">Media Router Manager</a>
                </div>

                <!-- User Button  -->
                <button id="@{_userButton}" type="button" class="appFrame-btn-user" data-bs-toggle="modal" data-bs-target="#@{_modal_log_out}"
                    title="Log in or out">
                </button>

                

            </div>
        </nav>

       
        <!-- Alert message -->
        <div id="@{_disconnectAlert}" class="appFrame-login-alert-container">
            <div class="appFrame-login-alert-icon"></div>
            <div class="appFrame-login-alert-text">You have lost connection!</div>
        </div>
      


        <!-- Modal log out -->
        <div class="modal fade fixed top-0 left-0 hidden w-full h-full outline-none overflow-x-hidden overflow-y-auto"
        id="@{_modal_log_out}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-sm relative w-auto pointer-events-none">
            <div
            class="modal-content border-none shadow-lg relative flex flex-col w-full pointer-events-auto bg-white bg-clip-padding rounded-md outline-none text-current">
            <div
                class="modal-header flex flex-shrink-0 items-center justify-between p-4 border-b border-gray-200 rounded-t-md">

                <div class="inline modal-header h-[1.875rem] w-[1.875rem] bg-logout bg-cover bg-center bg-no-repeat"></div>
                <h5 class="ml-2 text-xl font-medium leading-normal text-gray-800" id="exampleModalLabel"> Log out</h5>

                <button type="button"
                class="btn-close box-content w-4 h-4 p-1 text-black border-none rounded-none opacity-50 focus:shadow-none
                focus:outline-none focus:opacity-100 hover:text-black hover:opacity-75 hover:no-underline"
                data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body relative p-4">
                Are you sure you want to log-out?
            </div>
            <div
                class="modal-footer flex flex-shrink-0 flex-wrap items-center justify-end p-4 border-t border-gray-200 rounded-b-md">
                <button type="button" id="@{_logOutButton}" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs 
                    leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                    focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                 Log out</button>
            </div>
            </div>
        </div>
        </div>

    
        <!-- Log in form  -->
        <div id="@{_formLogIn}" class="appFrame-login-form">
            <div id="@{_logInContainer}" class="appFrame-login-container">
            
                <!-- Alert message -->
                <div id="@{_incorrectPassAlert}" class="appFrame-login-alert-container">
                    <div class="appFrame-login-alert-icon"></div>
                    <div class="appFrame-login-alert-text">Incorrect email or password!</div>
                </div>

                <div>
                    <!-- Username input -->
                    <div class="form-group mb-6">
                        <label for="@{_userName}" class="appFrame-login-label">Username</label>
                        <input type="userName" id="@{_userName}" class="appFrame-login-username" 
                        title="Enter your Username" placeholder="Enter Username" value="testUser1">
                    </div>

                    <!-- Password input -->
                    <div class="form-group mb-6">
                        <label for="@{_userPassword}" class="appFrame-login-label">Password</label>
                        <input type="password" id="@{_userPassword}" class="appFrame-login-password"
                        placeholder="Password" value="testPass" title="Enter your password">
                    </div>
                    
                    <div class="appFrame-login-flex-div">
                        <!-- Remember me checkbox -->
                        <div class="form-group form-check" title="Check this to remember log in details">
                            <input type="checkbox" id="@{_userRemember}" class="appFrame-login-remember-checkbox">
                            <label class="appFrame-login-remember-label" for="@{_userRemember}">Remember me</label>
                        </div>

                        <!-- Forgot Password link -->
                        <a href="#!" class="appFrame-login-forgot-pass">Forgot password?</a>
                    </div>

                    <!-- Sign in button-->
                    <button id="@{_signIn}" title="Click to sign in" class="appFrame-login-sign-in-button">Sign in</button>

                        
                </div>
            </div>
        </div> 

        <!-- Simple List 

            <!-- Device Lists-->
            <div id="@{_controlsDiv}" class="list-group pb-4 pt-2 h-auto w-auto hidden"></div>

            
        `;

    }

    Init() {
        
        Sortable.create(this._controlsDiv, {
            animation: 350,
            chosenClass: "sortable-chosen",
            dragClass: "sortable-drag"
        });

        
        // Set initial values
        this._hideAlert();
        this._disconnectAlert.style.display = "none";
        this._addButton.disabled = true;
        this._userButton.disabled = true;
        

        // Event subscriptions
        this._addButton.addEventListener('click', (e) => {
            // Get unique random name
            function randomName() {
                return "router_" + Math.round(Math.random() * 10000);
            }
            
            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new router
            this.SetData({[name]: {controlType: "DeviceList"}});
            this.on(name, control => {
                // send newly created router's data to manager
                this._notify({[name]: control.GetData()});
            });
        });

        this._logOutButton.addEventListener('click', (e) => {
            this.clearControls();
            this._addButton.disabled = true;
            this._userButton.disabled = true;
            this._formLogIn.style.display = "flex";
            this._controlsDiv.style.display = "none";
            this._incorrectPassAlert.style.display = "none";
            this._userName.value = "";
            this._userPassword.value = "";
            this._userName.focus();
        });

        this._userRemember.addEventListener('click', (e) => {
            
        });

        this._signIn.addEventListener('click', (e) => {
            this.emit('login', { username: this._userName.value, password: this._userPassword.value  });
        });

        // Handle property changes

        // this.on('userName', userName => {
        //     this._userName.value = userName;
        // });

        // this.on('userPassword', userPassword => {
        //     this._userPassword.value = userPassword;
        // });


    }

    _hideAlert() {
        
        this._incorrectPassAlert.style.display = "none";
        
    }

    logIn() {
        this._addButton.disabled = false;
        this._userButton.disabled = false;
        this._controlsDiv.style.display = "block";
        this._formLogIn.style.display = "none";
        this._incorrectPassAlert.style.display = "none";
}
      
    clearControls() {
        Object.keys(this._controls).forEach(control => {
            this.RemoveChild(control);
        });
    }
    // this._incorrectPassAlert.style.display = "block";
    // this._userName.focus();
    
}
