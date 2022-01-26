// =====================================
// Tab Button
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiTabButton extends _uiControl {
  constructor() {
    super();
    this.tabImagePath = "path/to/image.png";
    this._tabPage = undefined; // Reference to the uiTabPage that this button is controlling. This is set by the uiTabController
    this._hideData = true; // Hide uiTabButton data from GetData by default
    this._styles.push("controls/css/uiTabButton.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main">
        <!-- ${this.name} -->
        <li class="uiTabButton" id="${this._uuid}_button">
          <img src="${this.tabImagePath}">
        </li>  
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._button = document.getElementById(`${this._uuid}_button`);

    // Event handling
    let o = this;
    this._button.addEventListener("click", function () {
      o.dispatch("click", o);
    });
  }

  Select() {
    // Change background colour to selected colour
    this._mainDiv.style.backgroundColor = "#efefef";
    this._mainDiv.style.borderRadius = "0px 10px 10px 0px";
    this._mainDiv.style.marginRight = "10px";
    this._mainDiv.style.className = "uiTabButton-selected";
  }

  Deselect() {
    this._mainDiv.style.backgroundColor = "grey";
  }
}
