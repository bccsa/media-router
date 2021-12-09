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
function socketConnet(){
    managerio = io(
        {
            auth: {
                username: "user",
                password: "pass",
            },
        }
    );// socket.io comunication
};



