// =====================================
// Tab Page
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiTabPage extends _uiControl {
  constructor() {
    super();
    this.tabImagePath = "path/to/image.png";
    this._styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main">
        <!-- ${this.name} -->
        <div id="${this._uuid}_controls"></div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);

    // Prompt the parent uiTabController to create a tab button
    if (this._parent.CreateTab) {
      this._parent.CreateTab(this);
    }
  }

  // Override method removes html and prompts the parent uiTabController to remove the tab button.
  RemoveHtml() {
    this._mainDiv.remove();
    if (this._parent.RemoveTab) {
      this._parent.RemoveTab(this);
    }
  }

  Show() {
    if (this._init) {
      this._controlsDiv.style.display = "block";
    }
    else {
      // Wait for control to be initialized
      this.on("init", (c) => {
        c.Show();
      });
    }
  }

  Hide() {
    if (this._init) {
      this._controlsDiv.style.display = "none";
    }
    else {
      // Wait for control to be initialized
      this.on("init", (c) => {
        c.Hide();
      });
    }
  }
  
}
