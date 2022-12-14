// =====================================
// Settings controls
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiSetting extends _uiControl {
  constructor() {
    super();
    this.displayName = ""; 
    this._styles.push("controls/css/uiSettings.css");

    // Add small uiComponents
    this.SetData({
      controlLabel: {
        controlType: "uiTextBox",
        name: "controlLabel",
        displayName: "controlLabel",
        parentElement: "_setting",
      },
      controlLabel1: {
        controlType: "uiTextBox",
        name: "controlLabel1",
        displayName: "controlLabel1",
        parentElement: "_setting",
      },
      controlLabel2: {
        controlType: "uiTextBox",
        name: "controlLabel2",
        displayName: "controlLabel2",
        parentElement: "_setting",
      },
      controlLabel3: {
        controlType: "uiCheckbox",
        name: "controlLabel3",
        displayName: "controlLabel3",
        parentElement: "_setting",
      },
      controlLabel4: {
        controlType: "uiCheckbox",
        name: "controlLabel4",
        displayName: "controlLabel4",
        parentElement: "_setting",
      },
      controlLabel5: {
        controlType: "uiCheckbox",
        name: "controlLabel5",
        displayName: "controlLabel5",
        parentElement: "_setting",
      },
      controlLabel6: {
        controlType: "uiCheckbox",
        name: "controlLabel6",
        displayName: "controlLabel6",
        parentElement: "_setting",
      },
    });
  }
  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
    <!-- ${this.name} --> 
        <div class="setting" id="${this._uuid}_setting" draggable="true" >
          <div class=""> <h3 > ${this.displayName} </h3> </div>  
        </div>
    `;
  }

  Init() {
    this._setting = document.getElementById(`${this._uuid}_setting`);
  }
}
