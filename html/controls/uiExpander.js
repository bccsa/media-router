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
    this._styles.push("controls/css/uiExpander.css");

    // Add header controls container to the topBar element
    this.SetData({
      header: {
        controlType: "uiSimpleContainer",
        name: "header",
        displayName: this.displayName,
        parentElement: "_topBar",
      }
    });
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main" class="uiExpander" >
        <!-- ${this.name} -->
        <div id="${this._uuid}_topBar" class="uiExpander_topbar" >
          <p class="uiDraggable_drag" id="${this._uuid}_label">${this.displayName}</p>          
        </div>
        <div id="${this._uuid}_controls"></div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._label = document.getElementById(`${this._uuid}_label`);
    this._topBar = document.getElementById(`${this._uuid}_topBar`);

    // Add event listeners
    let o = this;
    this._topBar.addEventListener("dblclick", function () {
      if (o._controlsDiv.style.display != "block") {
        o._controlsDiv.style.display = "block";
      } else {
        o._controlsDiv.style.display = "none";
      }
    });


    // Event handling
    // this._mainDiv.addEventListener("dragstart", (e) => {
    //    //if(e.path[0].className == "uiExpander"){
    //     o._mainDiv.classList.add("dragging");  
    //    //}    
    // });

    // this._mainDiv.addEventListener("dragend", (e) => {
    //     // e.stopPropagation();
    //     o._mainDiv.classList.remove("dragging");  
    // });


  }

  Update(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._label.innerText = this.displayName;
        break;
      }
      
    }
  }
}
