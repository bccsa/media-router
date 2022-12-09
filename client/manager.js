var controls = new uiTopLevelContainer('../controls', 'controls');

let pList = [];
pList.push(controls.LoadScript("_audioDevice" + ".js"));
pList.push(controls.LoadScript("AudioInputDevice" + ".js"));

Promise.all(pList).then(() => {
    controls.SetData({
    
        DeviceList1: {
            controlType: "DeviceList",
                
            AudioInput_SCC_Pulpit:{
                controlType: "AudioInputDevice"
            },
    
            AudioInput_ENG:{
                controlType: "AudioInputDevice"
            },
    
            AudioInput_FRA:{
                controlType: "AudioInputDevice"
            }
        }
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
