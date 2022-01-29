// =====================================
// Draggable controls
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiDraggable extends _uiControl {
  constructor() {
    super();
    this.displayName = "";
    this._styles.push("controls/css/uiDraggable.css");

    // Add small uiComponents
    this.SetData({
      controlLabel: {
        controlType: "uiTextBox",
        name: "controlLabel",
        displayName: "controlLabel",
        parentElement: "_draggable",
      },
      controlLabel1: {
        controlType: "uiTextBox",
        name: "controlLabel1",
        displayName: "controlLabel1",
        parentElement: "_draggable",
      },
      controlLabel2: {
        controlType: "uiTextBox",
        name: "controlLabel2",
        displayName: "controlLabel2",
        parentElement: "_draggable",
      },
      controlLabel3: {
        controlType: "uiCheckbox",
        name: "controlLabel3",
        displayName: "controlLabel3",
        parentElement: "_draggable",
      },
      controlLabel4: {
        controlType: "uiCheckbox",
        name: "controlLabel4",
        displayName: "controlLabel4",
        parentElement: "_draggable",
      },
      controlLabel5: {
        controlType: "uiCheckbox",
        name: "controlLabel5",
        displayName: "controlLabel5",
        parentElement: "_draggable",
      },
      controlLabel6: {
        controlType: "uiCheckbox",
        name: "controlLabel6",
        displayName: "controlLabel6",
        parentElement: "_draggable",
      },
    });
  }
  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <!-- ${this.name} --> 
          <div class="row draggable" id="${this._uuid}_draggable"  >
            <div class="col-lg-12 drag" > <h3 draggable="true"> ${this.displayName} </h3> </div>  
          </div>
      `;
  }

  Init() {
    this._draggable = document.getElementById(`${this._uuid}_draggable`);
    this._draggables = document.querySelectorAll(".draggable");

    this._draggables.forEach((drag) => {
      const box = drag.getBoundingClientRect();
      console.log(box.y);
    });

    let o = this;
    //Subscribe to event that will give the drag position.
    // this._mainDiv.addEventListener('dragMoveEvent', () => {
    //   //Set the position property in this control
    //   this._dragPos = "Drag position in whatever format";
    //   this._parent.SetChildPos(o);
    // });

    this._draggable.addEventListener("dragstart", () => {
      o._draggable.classList.add("dragging");
    });

    this._draggable.addEventListener("dragend", () => {
      o._draggable.classList.remove("dragging");
    });
  }
}
