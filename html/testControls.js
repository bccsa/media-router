const controlsDiv = document.getElementById("controls");

const container = new uiSimpleContainer();

controlsDiv.innerHTML += container.html;
container.DomLinkup();
container._init = true;

// Subscribe to the "data" event
container.on("data", (data) => {
  console.log(JSON.stringify(data, null, 2));
});

// let data = 
container.SetData({
  expander1: {
    name:"expander1",
    controlType:"uiExpander",
    header: {
      testButton1: {
        controlType: "uiButton",
        name: "testButton1",
        displayName: "Hi Etienne1!"
      }
    }
  },
  expander2: {
    name:"expander2",
    controlType:"uiExpander",
    header: {
      testButton2: {
        controlType: "uiButton",
        name: "testButton2",
        displayName: "Hi Etienne2!"
      }
    }
  }  
});









  
  
  
  
  
  
  
  //,
  // etienneCoentrol: {
  //   name: "etienneControl",
  //   displayName: "This is Etienne's control",
  //   helpText: "new control help text",
  //   controlType: "uiTextBox",
  //   value: "Hi Etienne!",
  // },
  // testButton: {
  //   name: "testButton",
  //   displayName: "test",
  //   controlType: "uiButton",
  // },
  // testCheckBox: {
  //   name: "testCheckBox",
  //   displayName: "Check",
  //   controlType: "uiCheckbox",
  // },
  // testSwitch: {
  //   name: "testSwitch",
  //   displayName: "Switch",
  //   controlType: "uiSwitchButton",
  // },
  // eventLog: {
  //   name: "testterminal",
  //   displayName: "terminal",
  //   controlType: "uiEventLog",
  // },
  // confirmButton: {
  //   name: "modalButton",
  //   displayName: "modal button",
  //   controlType: "uiConfirmButton",
  // },
  // statusControl: {
  //   name: "statusControl",
  //   displayName: "status control",
  //   controlType: "uiStatus",
  // },
  // statusControl: {
  //   name: "statusControl",
  //   displayName: "status control",
  //   controlType: "uiStatus",
  // },
  // statusControl: {
  //   name: "statusControl",
  //   displayName: "status control",
  //   controlType: "uiStatus",
  // },
  // statusControl: {
  //   name: "statusControl",
  //   displayName: "status control",
  //   controlType: "uiStatus",
  // },
  // ivanControl: {
  //   name: "ivanControl",
  //   displayName: "This is Ivan's control",
  //   helpText: "new control help text",
  //   controlType: "uiTextBox",
  //   value: "Hi Ivan!",
  //   oswaldControl: {
  //     name: "oswaldControl",
  //     displayName: "This is Oswald's control",
  //     helpText: "new control help text",
  //     controlType: "uiTextBox",
  //     value: "Hi Oswald!",
  //     oswald1Control: {
  //       name: "oswald1Control",
  //       displayName: "This is Oswald's 1 control",
  //       helpText: "new control help text",
  //       controlType: "uiTextBox",
  //       value: "Hi Oswald 1!",
  //     },
  //     oswald2Control: {
  //       name: "oswald2Control",
  //       displayName: "This is Oswald's 2 control",
  //       helpText: "new control help text",
  //       controlType: "uiTextBox",
  //       value: "Hi Oswald 2!",
  //     },
  //   },
  // },
// };////
// setTimeout(() => {
//   // console.log(JSON.stringify(textBox1.GetData(), null, 2));
//   // console.log(textBox1.GetData());

//   let copy = textBox1.GetData();
//   copy.name = "newParam";
//   copy.value = "Copy of the first Textbox";

//   // textBox1.SetData({
//   //     "Param1": copy
//   // })

//   textBox1._controls["testButton"].on("click", (btn) => {
//     console.log(`${btn.name} clicked!`);
//   });
// }, 100);

// setTimeout(() => {
//   let remData = {
//     ivanControl: {
//       oswaldControl: "",
//     },
//   };

//   let addData = {
//     ivanControl: {
//       oswald3Control: {
//         name: "oswald3Control",
//         displayName: "This is Oswald's 3 control",
//         helpText: "new control help text",
//         controlType: "uiTextBox",
//         value: "Hi Oswald 3!",
//       },
//     },
//   };
// 
//   let testButtonHelptext = {
//     testButton: {
//       helpText: "Test new help text",
//       styleClass: "btn btn-default",
//     },
//   };
//   // let remData = {
//   //     "ivanControl": ""
//   // }

//   textBox1.Remove(remData);
//   textBox1.SetData(addData);
//   textBox1.SetData(testButtonHelptext);

//   // console.log(JSON.stringify(textBox1.GetData(), null, 2));
//   // console.log(textBox1.GetData());
// }, 4000);

// setTimeout(() => {
//   let changeData = {
//     ivanControl: {
//       oswald3Control: {
//         displayName: "This is Oswald's 3 control - changed",
//         value: "Hi Oswald 3 - changed!",
//       },
//     },
//   };

//   textBox1.SetData(changeData);
// }, 000);
