

class _AppFrame extends ui {
    constructor() {
        super();
        this.userEmail = "";
        this.userPassword = "";
        this.deviceType = "_AppFrame";
        this._controlsDiv = undefined;
    }

    get html() {
        return `
        <nav
        class="relative w-full h-12 flex flex-wrap justify-between py-2 bg-gray-900 text-gray-200 shadow-lg">
            <div class="container-fluid w-full flex flex-wrap justify-between px-6">

            <button id="${this._uuid}_addButton" type="button" class="appFrame-btn-add"
                        title="Add a new DeviceList">
                        </button>

            <div class="container-fluid">
                <a class="mb-4 text-2xl text-white font-['Open-sans']" href="#"
                >Media Router Manager</a
                >
            </div>

            <button id="${this._uuid}_userButton" type="button" class="appFrame-btn-user"
                        title="User">
                        </button>

            </div>
        </nav>

        <div id="${this._uuid}_incorrectPassAlert" class="bg-yellow-100 rounded-lg py-5 px-6 mb-3 text-base text-yellow-700 inline-flex items-center w-full" role="alert">
            <svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="exclamation-triangle" class="w-4 h-4 mr-2 fill-current" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512">
                <path fill="currentColor" d="M569.517 440.013C587.975 472.007 564.806 512 527.94 512H48.054c-36.937 0-59.999-40.055-41.577-71.987L246.423 23.985c18.467-32.009 64.72-31.951 83.154 0l239.94 416.028zM288 354c-25.405 0-46 20.595-46 46s20.595 46 46 46 46-20.595 46-46-20.595-46-46-46zm-43.673-165.346l7.418 136c.347 6.364 5.609 11.346 11.982 11.346h48.546c6.373 0 11.635-4.982 11.982-11.346l7.418-136c.375-6.874-5.098-12.654-11.982-12.654h-63.383c-6.884 0-12.356 5.78-11.981 12.654z"></path>
            </svg>
            Incorrect email or password!
        </div>

        <div id="${this._uuid}_formLogIn" class="flex items-center h-[36rem] w-full bg-teal-lighter">
            <div class="w-full bg-white rounded shadow-lg p-8 m-4 md:max-w-sm md:mx-auto">
            
                <form>
                <div class="form-group mb-6">
                    <label for="${this._uuid}_userEmail" class="form-label inline-block mb-2 text-gray-700">Email address</label>
                    <input type="email" id="${this._uuid}_userEmail" class="form-control block w-full px-3 py-1.5 text-base font-normal text-gray-700
                    bg-white bg-clip-padding border border-solid border-gray-300 rounded transition ease-in-out
                    m-0 focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none" 
                    aria-describedby="emailHelp" placeholder="Enter email">
                </div>
                <div class="form-group mb-6">
                    <label for="${this._uuid}_userPassword" class="form-label inline-block mb-2 text-gray-700">Password</label>
                    <input type="password" id="${this._uuid}_userPassword" class="form-control block
                    w-full px-3 py-1.5 text-base font-normal text-gray-700 bg-white bg-clip-padding
                    border border-solid border-gray-300 rounded transition ease-in-out  m-0
                    focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none" "
                    placeholder="Password">
                </div>
                <div class="flex justify-between items-center mb-6">
                    <div class="form-group form-check">
                    <input type="checkbox" id="${this._uuid}_userRemember"
                        class="form-check-input appearance-none h-4 w-4 border border-gray-300 rounded-sm bg-white checked:bg-blue-600
                        checked:border-blue-600 focus:outline-none transition duration-200 mt-1 align-top bg-no-repeat bg-center bg-contain float-left mr-2 cursor-pointer">
                    <label class="form-check-label inline-block text-gray-800" for="${this._uuid}_userRemember">Remember me</label>
                    </div>
                    <a href="#!"
                    class="text-blue-600 hover:text-blue-700 focus:text-blue-700 transition duration-200 ease-in-out">Forgot
                    password?</a>
                </div>
                <button type="submit" id="${this._uuid}_signIn" class="w-full px-6 py-2.5 bg-blue-600 text-white font-medium text-xs leading-tight
                    uppercase rounded shadow-md hover:bg-blue-700 hover:shadow-lg
                    focus:bg-blue-700 focus:shadow-lg focus:outline-none focus:ring-0
                    active:bg-blue-800 active:shadow-lg transition duration-150
                    ease-in-out">Sign in</button>
                <p class="text-gray-800 mt-6 text-center">Not a member? <a href="#!"
                    class="text-blue-600 hover:text-blue-700 focus:text-blue-700 transition duration-200 ease-in-out">Register</a>
                </p>
                </form>
            
            </div>
        </div>

        

        
        <div id="${this._uuid}_deviceLists" class="pb-4 pt-2 h-auto w-auto hidden"></div>
        `;

    }

    Init() {
        this._controlsDiv = document.getElementById(`${this._uuid}_deviceLists`);

        this._formLogIn = document.getElementById(`${this._uuid}_formLogIn`);
        this._signIn = document.getElementById(`${this._uuid}_signIn`);
        this._addButton = document.getElementById(`${this._uuid}_addButton`);
        this._userButton = document.getElementById(`${this._uuid}_userButton`);
        this._userEmail = document.getElementById(`${this._uuid}_userEmail`);
        this._userPassword = document.getElementById(`${this._uuid}_userPassword`);
        this._incorrectPassAlert = document.getElementById(`${this._uuid}_incorrectPassAlert`);

        // Set initial values
        this._hideAlert();

        // Event subscriptions
        this._addButton.addEventListener('click', (e) => {
            
        });

        this._userButton.addEventListener('click', (e) => {
            
        });

        this._userEmail.addEventListener('change', (e) => {
            this.userEmail = this._userEmail.value;
        });

        this._userPassword.addEventListener('change', (e) => {
            this.userPassword = this._userPassword.value;
        });

        this._signIn.addEventListener('click', (e) => {
            this._logIn();
        });

        // Handle property changes

        this.on('userEmail', userEmail => {
            this._userEmail.value = userEmail;
        });

        this.on('userPassword', userPassword => {
            this._userPassword.value = userPassword;
        });


    }

    _hideAlert() {
        
        this._incorrectPassAlert.style.display = "none";
        
    }

    _logIn() {
        if (this.userEmail == "Admin" && this.userPassword == "Admin") {
            this._controlsDiv.style.display = "block";
            this._formLogIn.style.display = "none";
            this._incorrectPassAlert.style.display = "none";
        } else {
            this._incorrectPassAlert.style.display = "block";
        }
    }

    
}
