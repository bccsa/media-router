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
    this.displayName = "General";
    this._styles.push("controls/css/bootstrap.min.css");

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
        controlType: "uiTextBox",
        name: "controlLabel3",
        displayName: "controlLabel3",
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
        <div class="row" id="${this._uuid}_setting">
          <span class=""> ${this.displayName} </span>  
        </div>
    `;
  }

  DomLinkup() {
    this._setting = document.getElementById(`${this._uuid}_setting`);
  }
}
