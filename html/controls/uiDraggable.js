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
        <div id="${this._uuid}_controls"></div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._header = document.getElementById(`${this._uuid}_header`);

    // Event handling
    let o = this;
    this._header.addEventListener("dragstart", () => {
      o._header.classList.add("uiDraggable_dragging");
    });

    this._header.addEventListener("dragend", () => {
      o._header.classList.remove("uiDraggable_dragging");
    });
  }
}
