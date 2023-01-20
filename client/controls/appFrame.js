class appFrame extends ui {
    constructor() {
        super();
        this.userName = "Admin";
    }

    get html() {
        return `
        <!-- Nav bar  -->
        <nav class="appFrame-top-bar">
            <div class="appFrame-top-flex-div">
                <!-- Add Button  -->
                <button id="@{_addButton}" type="button" class="appFrame-btn-add" data-bs-toggle="modal" data-bs-target="#@{_modal_add_deviceList}"
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


        <!-- Modal log out -->
        <div class="modal fade fixed top-0 left-0 hidden  w-full h-full outline-none overflow-x-hidden overflow-y-auto"
        id="@{_modal_log_out}" tabindex="-1" aria-labelledby="exampleModalLabel" aria-hidden="true">
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
                <button type="button" class="px-6
                py-2.5  bg-purple-600 text-white font-medium text-xs leading-tight uppercase rounded shadow-md
                hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg focus:outline-none focus:ring-0
                active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">Log out</button>
            </div>
            </div>
        </div>
        </div>

        

        <!-- Modal add deviceList -->
        <div class="modal fade fixed top-0 left-0 hidden w-full h-full outline-none overflow-x-hidden overflow-y-auto"
        id="@{_modal_add_deviceList}" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1"
        aria-labelledby="staticBackdropLabel" aria-hidden="true">
        <div class="modal-dialog relative w-auto pointer-events-none">
            <div
            class="modal-content border-none shadow-lg relative flex flex-col w-full pointer-events-auto bg-white bg-clip-padding rounded-md outline-none text-current">
            <div
                class="modal-header flex flex-shrink-0 items-center justify-between p-4 border-b border-gray-200 rounded-t-md">
                <h5 class="text-xl font-medium leading-normal text-gray-800" id="exampleModalLabel">
                Modal title
                </h5>
                <button type="button"
                class="btn-close box-content w-4 h-4 p-1 text-black border-none rounded-none opacity-50 focus:shadow-none focus:outline-none focus:opacity-100 hover:text-black hover:opacity-75 hover:no-underline"
                data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body relative p-4">
                ...
            </div>
            <div
                class="modal-footer flex flex-shrink-0 flex-wrap items-center justify-end p-4 border-t border-gray-200 rounded-b-md">
                <button type="button"
                class="inline-block px-6 py-2.5 bg-purple-600 text-white font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out"
                data-bs-dismiss="modal">Close</button>
                <button type="button"
                class="inline-block px-6 py-2.5 bg-blue-600 text-white font-medium text-xs leading-tight uppercase rounded shadow-md hover:bg-blue-700 hover:shadow-lg focus:bg-blue-700 focus:shadow-lg focus:outline-none focus:ring-0 active:bg-blue-800 active:shadow-lg transition duration-150 ease-in-out ml-1">Understood</button>
            </div>
            </div>
        </div>
        </div>

        

        <!-- Log in form  -->
        <div id="@{_formLogIn}" class="appFrame-login-form">
            <div class="appFrame-login-container">
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
                        title="Enter your userName" placeholder="Enter userName" value="testUser1">
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

        <!-- Device Lists-->
        <div id="@{_controlsDiv}" class="pb-4 pt-2 h-auto w-auto hidden"></div>
        `;

    }

    Init() {
        // this._addButton = document.getElementById(`${this._uuid}_addButton`);
        // this._userButton = document.getElementById(`${this._uuid}_userButton`);
        // this._formLogIn = document.getElementById(`${this._uuid}_formLogIn`);
        // this._incorrectPassAlert = document.getElementById(`${this._uuid}_incorrectPassAlert`);
        // this._userName = document.getElementById(`${this._uuid}_userName`);
        // this._userPassword = document.getElementById(`${this._uuid}_userPassword`);
        // this._userRemember = document.getElementById(`${this._uuid}_userRemember`);
        // this._signIn = document.getElementById(`${this._uuid}_signIn`);
        // this._controlsDiv = document.getElementById(`${this._uuid}_controlsDiv`);
        // this._modal-log-out = document.getElementById(`${this._uuid}_modal-log-out`);

        
        // Set initial values
        this._hideAlert();

        // Event subscriptions
        this._addButton.addEventListener('click', (e) => {
            controls.appFrame.SetData({router3: {controlType: "DeviceList"}})
        });

        // this._userName.addEventListener('change', (e) => {
        //     this.userName = this._userName.value;
        // });

        // this._userPassword.addEventListener('change', (e) => {
        //     this.userPassword = this._userPassword.value;
        // });

        this._userRemember.addEventListener('click', (e) => {
            
        });

        this._signIn.addEventListener('click', (e) => {
            this.emit('login', { username: this._userName.value, password: this._userPassword.value  });
        });

        // Handle property changes

        this.on('userName', userName => {
            this._userName.value = userName;
        });

        this.on('userPassword', userPassword => {
            this._userPassword.value = userPassword;
        });


    }

    _hideAlert() {
        
        this._incorrectPassAlert.style.display = "none";
        
    }

    logIn() {
        
            this._controlsDiv.style.display = "block";
            this._formLogIn.style.display = "none";
            this._incorrectPassAlert.style.display = "none";
    
    }
      
    // this._incorrectPassAlert.style.display = "block";
    // this._userName.focus();
    
}
