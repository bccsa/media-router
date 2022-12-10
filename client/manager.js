var controls = new uiTopLevelContainer('../controls', 'controls');

let pList = [];
(controls.LoadScript("_audioDevice" + ".js")).then(() => {
    controls.LoadScript("_audioInputDevice" + ".js").then(() => {
        controls.SetData({

            DeviceList1: {
                controlType: "DeviceList",

                SrtOpusOutput: {
                    controlType: "SrtOpusOutput"
                },

                SrtOpusInput: {
                    controlType: "SrtOpusInput"
                },

                AudioInput: {
                    controlType: "AudioInput"
                },

                AudioOutput: {
                    controlType: "AudioOutput"
                }


            }
        });
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
