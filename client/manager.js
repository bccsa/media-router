var controls = new uiTopLevelContainer('../controls', 'controls');

controls.SetData({
    appFrame: {
        controlType: "appFrame"
    }
});

controls.on('appFrame', appFrame => {
    appFrame.on('login', data => {
        var socket = io({ auth: { username: data.username, password: data.password } });
        // var socket = io({ auth: { username: 'testUser1', password: 'testPass' } });

        socket.on('connect_error', err => {
            console.log('Unable to connect to manager: ' + err.message);
        });

        socket.on('connect', () => {
            console.log('Connected to manager');
            appFrame.logIn();
        });

        socket.on('data', data => {
            controls.appFrame.SetData(data);
        });

        controls.on('data', data => {
            console.log(data);
        });
    });
});

let pList = [];
(controls.LoadScript("_audioDevice" + ".js")).then(() => {
    controls.LoadScript("_audioInputDevice" + ".js").then(() => {




        // controls.SetData({

        //     DeviceList1: {
        //         controlType: "DeviceList",

        //         SrtOpusOutput: {
        //             controlType: "SrtOpusOutput"
        //         },

        //         SrtOpusInput: {
        //             controlType: "SrtOpusInput"
        //         },

        //         AudioInput: {
        //             controlType: "AudioInput"
        //         },

        //         AudioOutput: {
        //             controlType: "AudioOutput"
        //         }
        //     },

        //     DeviceList2: {
        //         controlType: "DeviceList",

        //         SrtOpusOutput: {
        //             controlType: "SrtOpusOutput"
        //         },

        //         SrtOpusInput: {
        //             controlType: "SrtOpusInput"
        //         },

        //         AudioInput: {
        //             controlType: "AudioInput"
        //         },

        //         AudioOutput: {
        //             controlType: "AudioOutput"
        //         }
        //     }

        // });
    });
});


// function toggleContainer(uuidContainer,uuidButton) {
//     var container = document.getElementById(uuidContainer);
//     var toggleButton = document.getElementById(uuidButton);
//     if (container.style.display === "none") {
//         container.style.display = "block";
//         toggleButton.textContent = "▲";
//     } else {
//         container.style.display = "none";
//         toggleButton.textContent = "▼";
//     }
// }

// function toggleMute(uuid) {
//     var myAudio = document.getElementById(uuid);
//     myAudio.muted = !myAudio.muted;
//  }

//  var un_mute = document.getElementById('un-mute');

// un_mute.onclick = function() {
//    alert('toggle player here');
// };
