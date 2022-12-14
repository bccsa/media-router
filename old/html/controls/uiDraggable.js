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
      <div id="${this._uuid}_mainDr" draggable=""true" class="uiDraggable">
        <!-- ${this.name} -->
        <div id="${this._uuid}_header" class="uiDraggable_drag">
          <h3>${this.displayName}</h3>
        </div>
        <div id="${this._uuid}_controls" class="uiDraggable_control">
        
        </div>
      </div>`;
  }

  Init() {
    this._mainDivDr = document.getElementById(`${this._uuid}_mainDr`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._header = document.getElementById(`${this._uuid}_header`);
    
    // this._sect1 = document.getElementById(`${this._uuid}_sect1`);
    // this._sect2 = document.getElementById(`${this._uuid}_sect2`);
    // this._sect3 = document.getElementById(`${this._uuid}_sect3`);

    // Event handling
   // if(this._parent.constructor.name === "uiDraggableList"){
      let o = this;
      this._mainDivDr.addEventListener("dragstart", (event) => { 
         // event.stopPropagation();
        o._mainDivDr.classList.add("dragging");  
      });
  
      this._mainDivDr.addEventListener("dragend", (event) => {
       //  event.stopPropagation();
       o._mainDivDr.classList.remove("dragging");  
      });
   // }
  
  }
}
