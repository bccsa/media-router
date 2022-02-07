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
    this.displayName = "New Draggable List item";
    this._styles.push("controls/css/uiDraggable.css");
  }
  
  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main" class="uiDraggable">
        <!-- ${this.name} -->
        <div id="${this._uuid}_header" class="uiDraggable_drag">
          <h3>${this.displayName}</h3>
        </div>
        <div id="${this._uuid}_controls" class="uiDraggable_control"></div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._header = document.getElementById(`${this._uuid}_header`);

    // Event handling
    if(this._parent.constructor.name === "uiDraggableList"){
      let o = this;
      this._mainDiv.addEventListener("dragstart", (event) => {
        event.stopPropagation();
         o._mainDiv.classList.add("dragging");  
      });
  
      this._mainDiv.addEventListener("dragend", (event) => {
        event.stopPropagation();
        o._mainDiv.classList.remove("dragging");  
      });
    }
  
  }
}
