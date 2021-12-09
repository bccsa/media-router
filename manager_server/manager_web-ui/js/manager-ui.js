//====================================================
// Global variables
//====================================================
 var managerio;


 //====================================================
// Socket.io
//====================================================

// -------------------------------------
// Socket.io authentication
// -------------------------------------

socketConnet();
// socket.io connection
function socketConnet(username, password){
    managerio = io(
        {
            auth: {
                username: username,
                password: password,
            },
        }
    );// socket.io comunication
};

// -------------------------------------
// Socket.io comunication
// -------------------------------------

managerio.on("Auth", () => {
    // hide login page and show manager page
    $(`#login`).hide();
    $(`#manager`).show();
})

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