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

function toggleContainer(uuid) {
    var x = document.getElementById(uuid);
    if (x.style.display === "none") {
      x.style.display = "block";
    } else {
      x.style.display = "none";
    }
}

function toggleMute(uuid) {
    var myAudio = document.getElementById(uuid);
    myAudio.muted = !myAudio.muted;
 }

 var un_mute = document.getElementById('un-mute');

un_mute.onclick = function() {
   alert('toggle player here');
};
