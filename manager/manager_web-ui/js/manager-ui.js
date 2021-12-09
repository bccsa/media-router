//====================================================
// Global variables
//====================================================


 //====================================================
// Socket.io
//====================================================

// -------------------------------------
// Socket.io authentication
// -------------------------------------

// socket.io connection
function socketConnet(username, password){
    const managerio = io(
        {
            auth: {
                username: username,
                password: password,
            },
        }
    );// socket.io comunication

    // log connection error 
    managerio.on("connect_error", (err) => {
        console.log(err);
        if (err.message === "Invalid username or password"){
            alert(err.message);
        };  
    })

    // on disconnect hide manager and show loginpage
    managerio.on("disconnect", () => {
        $(`#login`).show();
        $(`#manager`).hide();
    });

    // -------------------------------------
    // Socket.io comunication
    // -------------------------------------

    managerio.on("Auth", () => {
        // hide login page and show manager page
        $(`#login`).hide();
        $(`#manager`).show();
    })
};

//====================================================
// Button handling
//====================================================

// Login button
function btnLogin(){
    // variables
    let username = $(`#txtUsername`).val();
    let password = $(`#txtPassword`).val();

    // try connect to socket.io
    socketConnet(username, password);
}