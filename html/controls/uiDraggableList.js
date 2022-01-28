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
    this.displayName = "";
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiDraggableList.css");

    // Add small uiComponents
    this.SetData({
      draggable1: {
        controlType: "uiDraggable",
        name: "draggable1",
        parentElement: "_draggableList",
        displayName: "Mic 1",
      },
      draggable2: {
        controlType: "uiDraggable",
        name: "draggable2",
        parentElement: "_draggableList",
        displayName: "Mic 2",
      },
    });
  }
  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
            <div class="draggableList" id="${this._uuid}_draggableList"  >   

            </div>
        `;
  }

  Init() {
    this._draggableList = document.getElementById(
      `${this._uuid}_draggableList`
    );

    console.log(Object.keys(this._draggableList.children));
    console.log("Object.keys", this._draggableList.children);

    Object.keys(this._draggableList.children).forEach((drag) => {
      console.log("test", drag);
    });
  }
}
