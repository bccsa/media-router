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
    "testButton": {
        "displayName": "test",
        "controlType": "uiButton"
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