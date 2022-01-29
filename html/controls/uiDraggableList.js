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
        
      <div id="${this._uuid}_main" class="draggableList"> 
        <!-- ${this.name} --> 
      </div>
           
        `;
  }

  Init() {
    // this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._draggableList = document.getElementById(`${this._uuid}_main`);
    this._drags = document.querySelectorAll(".draggable");

    this._drags.forEach((draggable) => {
      console.log("ui", draggable);
    });

    let o = this;
    this._draggableList.addEventListener("dragover", (e) => {
      e.preventDefault();
      const draggable = document.querySelector(".dragging");
      o._draggableList.appendChild(draggable);
    });

    // console.log("drag", this._draggableList.childNodes);

    // console.log("Object.keys", this._draggableList.children);

    // Object.keys(this._draggableList).forEach((drag) => {
    //   console.log("test", drag);
    // });
  }

  // SetChildPos(control) {
  //   Object.keys
  //   if control._dragPos below postition of any control in this._controls
  // }
}
