// =====================================
// DraggableList controls
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiDraggableList extends _uiControl {
  constructor() {
    super();
    this._styles.push("controls/css/uiDraggableList.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main"> 
        <!-- ${this.name} --> 
        <div id="${this._uuid}_controls" class="uiDraggableList"></div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);

    // Import Sortable.create to Sortable librairy 
    let el = this._controlsDiv;
    Sortable.create(el, {
      handle: '.uiDraggable_drag', // handle's class
      animation: 150
    });
  }
}
