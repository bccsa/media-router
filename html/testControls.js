const controlsDiv = document.getElementById("controls");
// const Console = document.getElementById(`${this._uuid}_console`);

const container = new uiSimpleContainer();
container.name = "Top level container";

controlsDiv.innerHTML += container.html;
container.Init();
container._init = true;

// Subscribe to the "data" event
container.on("data", (data) => {
  console.log(JSON.stringify(data, null, 2));
});

container.SetData({
  // tabController1: {
  //   name: "tabController1",
  //   controlType: "uiTabController",
  //   tabPage1: {
  //     name: "tabPage1",
  //     controlType: "uiTabPage",
  //     tabImagePath: "assets/img/settings.png",


      DraggableList: {
        controlType: "uiDraggableList",
        name: "uiDraggableList-expander" ,
 
      expander1: {
        name: "expander1",
        displayName: "Douala",
        controlType: "uiExpander",
        // header: {
        statusC1: {
          controlType: "uiStatus",
          name: "Status Control 1",
          displayName: "Status Ctrl 1",
          parentElement: "header",
        },
        statusC2: {
          controlType: "uiStatus",
          name: "Status Control 2",
          displayName: "Status Ctrl 2",
          parentElement: "header",
        },
        statusC3: {
          controlType: "uiStatus",
          name: "Status Control 3",
          displayName: "Status Ctrl 3",
          parentElement: "header",
        },
        switchButton: {
          controlType: "uiSwitchButton",
          name: "Switch",
          parentElement: "header",
        },
        // },
        tabController1:{
            name: "tabController1",
            controlType: "uiTabController",
            tabPage1: {
              name: "tabPage1",
              controlType: "uiTabPage",
              tabImagePath: "assets/img/settings.png",
      
      DraggableList: {
        controlType: "uiDraggableList",
        name: "uiDraggableList",
        dragItem1: {
          name: "dragItem1",
          controlType: "uiDraggable",
          displayName: "Test Draggable",
          button1: {
            name: "button1",
            controlType: "uiButton",
            parentElement: "_controlsDiv"
          },
          button2: {
            name: "button2",
            controlType: "uiButton",
            parentElement: "_controlsDiv"
          },
          textbox1: {
            name: "textbox1",
            controlType: "uiTextBox",
            parentElement: "_controlsDiv"
          }
        },
        dragItem2: {
          name: "dragItem2",
          controlType: "uiDraggable",
          displayName: "Test Draggable2", 
          button2: {
            name: "button2",
            controlType: "uiTextBox",
            parentElement: "_controlsDiv"
          }, 
          button3: {
            name: "button3",
            controlType: "uiTextBox",
            parentElement: "_controlsDiv"
          },
          button4: {
            name: "button4",
            controlType: "uiTextBox",
            parentElement: "_controlsDiv"
          },
          button5: {
            name: "button5",
            controlType: "uiTextBox",
            parentElement: "_controlsDiv"
          },
          button6: {
            name: "button6",
            controlType: "uiTextBox",
            parentElement: "_controlsDiv"
          },
          check1: {
            name: "check1",
            controlType: "uiCheckbox",
            parentElement: "_controlsDiv"
          },
          check2: {
            name: "check2",
            controlType: "uiCheckbox",
            parentElement: "_controlsDiv"
          }  
        }
      },
    },
  }
},

expander2: {
  name: "expander2",
  displayName: "Yaounde",
  controlType: "uiExpander",
  // header: {
  statusC1: {
    controlType: "uiStatus",
    name: "Status Control 1",
    displayName: "Status Ctrl 1",
    parentElement: "header",
  },
  statusC4: {
    controlType: "uiStatus",
    name: "Status Control 4",
    displayName: "Status Ctrl 4",
    parentElement: "header",
  },
  statusC2: {
    controlType: "uiStatus",
    name: "Status Control 2",
    displayName: "Status Ctrl 2",
    parentElement: "header",
  },
  statusC3: {
    controlType: "uiStatus",
    name: "Status Control 3",
    displayName: "Status Ctrl 3",
    parentElement: "header",
  },
  switchButton: {
    controlType: "uiSwitchButton",
    name: "Switch",
    parentElement: "header",
  },
  // },
  tabController1:{
      name: "tabController1",
      controlType: "uiTabController",
      tabPage1: {
        name: "tabPage1",
        controlType: "uiTabPage",
        tabImagePath: "assets/img/settings.png",

DraggableList: {
  controlType: "uiDraggableList",
  name: "uiDraggableList",
  dragItem1: {
    name: "dragItem1",
    controlType: "uiDraggable",
    displayName: "Test Draggable",
    button1: {
      name: "button1",
      controlType: "uiButton",
      parentElement: "_sect1"
    }
  },
  dragItem2: {
    name: "dragItem2",
    controlType: "uiDraggable",
    displayName: "Test Draggable2",
    button1: {
      name: "button1",
      controlType: "uiButton",
      parentElement: "_sect2"
    },
    button2: {
      name: "button2",
      controlType: "uiTextBox",
      parentElement: "_sect2"
    },
    check1: {
      name: "check1",
      controlType: "uiCheckbox",
      parentElement: "_sect2"
    },
    check2: {
      name: "check2",
      controlType: "uiCheckbox",
      parentElement: "_sect2"
    }  
  }
},
},
}
},

 
   

  

},

 // },

  //   tabPage2:{
  //     name: "tabPage2",
  //     controlType: "uiTabPage",
  //     tabImagePath: "assets/img/list.png",
  //     expander2: {
  //       name: "expander2",
  //       displayName: "yde",
  //       controlType: "uiExpander", 
  //       header: {
  //         statusC1: {
  //           controlType: "uiStatus",
  //           name: "Status Control 1",
  //           displayName: "Status Ctrl 1",
  //         },
  //         statusC2: {
  //           controlType: "uiStatus",
  //           name: "Status Control 2",
  //           displayName: "Status Ctrl 2",
  //         },
  //         statusC3: {
  //           controlType: "uiStatus",
  //           name: "Status Control 3",
  //           displayName: "Status Ctrl 3",
  //         },
  //         switchButton: {
  //           controlType: "uiSwitchButton",
  //           name: "Switch",
  //         },
  //       },
  //     },
  //     eventLog: {
  //       controlType: "uiEventLog",
  //       name: "eventLog",
  //     },
  // //   },
  // },
});


// Add small uiComponents
// container.SetData({
//   draggable1: {
//     controlType: "uiDraggable",
//     name: "draggable1",
//     parentElement: "_draggableList",
//     displayName: "Mic 1",
//   },
//   draggable2: {
//     controlType: "uiDraggable",
//     name: "draggable2",
//     parentElement: "_draggableList",
//     displayName: "Mic 2",
//   },
//   draggable3: {
//     controlType: "uiDraggable",
//     name: "draggable3",
//     parentElement: "_draggableList",
//     displayName: "Mic 3",
//   },
//   draggable4: {
//     controlType: "uiDraggable",
//     name: "draggable4",
//     parentElement: "_draggableList",
//     displayName: "Mic 4",
//   },
// });

// let data =
// container.SetData({

//   ,
// });

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
