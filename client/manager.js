var controls = new uiTopLevelContainer('../controls', 'controls');

controls.SetData({
    AudioInput_SCC_Pulpit:{
        controlType: "AudioInput",
    },
    AudioInput_ENG:{
        controlType: "AudioInput",
    },
    AudioInput_FRA:{
        controlType: "AudioInput",
    }


    // AlbertsMixer: {
    //     controlType: "AudioMixer",
    // },
    // IvansMixer: {
    //     controlType: "AudioMixer",
    //     description: "This is a test"
    // }
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
