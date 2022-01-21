// =====================================
// Expander label and helptext
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiExpander extends _uiControl {
  constructor() {
    super();
    this.displayName = "new control"; // Display name
    this.helpText = "new control help text";
    this.margin = "10px";
    this.padding = "10px";
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiExpander.css");

    // Add header controls container to the topBar element
    this.SetData({
      header: {
        controlType: "uiSimpleContainer",
        name: "header",
        displayName: this.displayName,
        parentElement: "_topBar",
      },
      deleteBtn: {
        controlType: "uiButton",
        name: "deleteBtn",
        displayName: "Delete",
        parentElement: "_topBar",
        hidden: true,
      },
      modal: {
        controlType: "uiConfirmButton",
        name: "modal",
        displayName: "modal",
        parentElement: "_topBar",
      },
      startButton: {
        controlType: "uiButton",
        name: "startButton",
        displayName: "Start",
        parentElement: "_controlsDiv",
      },
      stopButton: {
        controlType: "uiButton",
        name: "startButton",
        displayName: "Stop",
        parentElement: "_controlsDiv",
      },
      controlButton1: {
        controlType: "uiButton",
        name: "controlButton1",
        displayName: "control 1",
        parentElement: "_controlsDiv",
      },
      controlButton2: {
        controlType: "uiButton",
        name: "controlButton2",
        displayName: "control 2",
        parentElement: "_controlsDiv",
      },
      eventLog: {
        controlType: "uiEventLog",
        parentElement: "_controlsDiv",
        name: "eventLog",
      },
      bar: {
        controlType: "uiBar",
        parentElement: "_controlsDiv",
        name: "bar",
      },
      settings: {
        controlType: "uiSetting",
        parentElement: "_controlsDiv",
        name: "setting",
      },
    });
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <div id="${this._uuid}_main" class="col-lg-12 "   style="margin:${this.margin}">
            <div id="${this._uuid}_topBar" class="col-lg-12 p-2 d-flex" style="background-color:grey;">
                <span class="title col-lg-6" id="${this._uuid}_label">${this.displayName}</span>          
            </div>
            <div class
              id="${this._uuid}_controls" 
              class="row d-flex" 
              style="
              background-color: #efefef; 
              float: left; 
              padding:${this.padding};
              width:100%;
              display:none;" > 
              
             
 
            </div>

            
        </div>`;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._label = document.getElementById(`${this._uuid}_label`);
    this._topBar = document.getElementById(`${this._uuid}_topBar`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._console = document.getElementById(`${this._uuid}_console`);
    this._btnSess = document.getElementById(`${this._uuid}_btnSess`);

    // Add event listeners
    let o = this;
    this._topBar.addEventListener("dblclick", function () {
      if (o._controlsDiv.style.display != "block") {
        o._controlsDiv.style.display = "block";
      } else {
        o._controlsDiv.style.display = "none";
      }
      console.log(o._controlsDiv.style.display);
    });

    // Listen for delete button event
    this._controls["deleteBtn"].on("click", () => {
      // Delete this control
      this.DomRemove();
    });
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._label.innerText = this.displayName;
        break;
      }
    }
  }
}
