 
const controlsDiv = document.getElementById(`controls`);
// const domBody = document.getElementById(`body`);
const domHead = document.getElementsByTagName(`head`)[0];

let _abortController = new AbortController();
document.addEventListener("DOMContentLoaded", _init, {
  signal: _abortController.signal,
});

function _init() {
  _abortController.abort();

  const textBox1 = new uiTextBox();
  textBox1.name = "Param1";
  textBox1.displayName = "Name";
  controlsDiv.innerHTML += textBox1.html;

  textBox1.DomLinkup();

  // Child controls
  const textBox2 = new uiTextBox();
  textBox2.value = "test value fuh";
  textBox1.AddControl(textBox2);

  textBox2.DomLinkup();

  // New ui control

  const textBox3 = new uiTextBox();
  textBox3.displayName = "Class";
  controlsDiv.innerHTML += textBox3.html;
  textBox3.value = "AB Testing";

  textBox3.DomLinkup();

  const button1 = new uiButton();
  button1.displayName = "Class";
  controlsDiv.innerHTML += button1.html;
  button1.value = "AB Testing";

  button1.DomLinkup();
=======
const controlsDiv = document.getElementById("controls");

const textBox1 = new uiTextBox();
textBox1.name = "Param1";
textBox1.displayName = "Top level";
textBox1.value = "Top level value";

controlsDiv.innerHTML += textBox1.html;
textBox1.DomLinkup();
textBox1._init = true;

let data = {
    "name": "Param1",
    "displayName": "Name",
    "helpText": "new control help text",
    "controlType": "uiTextBox",
    "value": "TextBox Value",
    "etienneControl": {
        "name": "etienneControl",
        "displayName": "This is Etienne's control",
        "helpText": "new control help text",
        "controlType": "uiTextBox",
        "value": "Hi Etienne!"
    },
    "ivanControl": {
        "name": "ivanControl",
        "displayName": "This is Ivan's control",
        "helpText": "new control help text",
        "controlType": "uiTextBox",
        "value": "Hi Ivan!",
        "oswaldControl": {
            "name": "oswaldControl",
            "displayName": "This is Oswald's control",
            "helpText": "new control help text",
            "controlType": "uiTextBox",
            "value": "Hi Oswald!",
            "oswald1Control": {
                "name": "oswald1Control",
                "displayName": "This is Oswald's 1 control",
                "helpText": "new control help text",
                "controlType": "uiTextBox",
                "value": "Hi Oswald 1!"
            },
            "oswald2Control": {
                "name": "oswald2Control",
                "displayName": "This is Oswald's 2 control",
                "helpText": "new control help text",
                "controlType": "uiTextBox",
                "value": "Hi Oswald 2!"
            }
        }
    } 
}

textBox1.SetData(data);

setTimeout(() => {
    // console.log(JSON.stringify(textBox1.GetData(), null, 2));
    // console.log(textBox1.GetData());

    let copy = textBox1.GetData();
    copy.name = "newParam";
    copy.value = "Copy of the first Textbox";

    // textBox1.SetData({
    //     "Param1": copy
    // })
}, 100);


setTimeout(() => {
    let remData = {
        "ivanControl": {
            "oswaldControl":""
        }
    }

    let addData = {
        "ivanControl": {
            "oswald3Control": {
                "name": "oswald3Control",
                "displayName": "This is Oswald's 3 control",
                "helpText": "new control help text",
                "controlType": "uiTextBox",
                "value": "Hi Oswald 3!"
            }
        }
        
    }

    // let remData = {
    //     "ivanControl": ""
    // }

    textBox1.Remove(remData);
    textBox1.SetData(addData);

    // console.log(JSON.stringify(textBox1.GetData(), null, 2));
    // console.log(textBox1.GetData());
}, 4000);

setTimeout(() => {
    let changeData = {
        "ivanControl": {
            "oswald3Control": {
                "displayName": "This is Oswald's 3 control - changed",
                "value": "Hi Oswald 3 - changed!"
            }
        }
    }

    textBox1.SetData(changeData);
}, 8000);