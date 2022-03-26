// =====================================
// Tab controller
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiTabController extends _uiControl {
  constructor() {
    super();
    this._styles.push("controls/css/uiTabController.css");
    this._buttons = {};
    this._tabCount = 0;
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main" class="uiTabController">
        <!-- ${this.name} --> 
        <div id="${this._uuid}_controls" class="uiTabController_controls"></div>
        <div class="uiTabController_buttons">
          <ul id="${this._uuid}_buttons"></ul>
        </div>
      </div
      `;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._tabButtons = document.getElementById(`${this._uuid}_buttons`);
  }

  CreateTab(tabPage) {
    if (tabPage.constructor.name == "uiTabPage") {
      // Create the tab button
      this.SetData({
        [`${tabPage.name}_button`]: {
          name: `${tabPage.name}_button`,
          controlType: "uiTabButton",
          tabImagePath: tabPage.tabImagePath,
          parentElement: "_tabButtons",
        },
      });

      let tabButton = this._controls[`${tabPage.name}_button`];

      // Add tab page reference to button
      tabButton._tabPage = tabPage;

      // Event handling
      tabButton.on("click", (tb) => {
        Object.keys(this._controls).forEach((k) => {
          let p = this._controls[k];
          if (p.constructor.name == "uiTabPage") {
            if (p == tb._tabPage) {
              p.Show();
            } else {
              p.Hide();
            }
          } else if (p.constructor.name == "uiTabButton") {
            if (p == tb) {
              p.Select();
            } else {
              p.Deselect();
            }
          }
        });
      });

      // Show the first tab page, and hide subsequent tab pages
      if (this._tabCount == 0) {
        tabPage.Show();
      } else {
        tabPage.Hide();
      }

      this._tabCount++;
    }
  }

  RemoveTab(tabPage) {
    // Remove the tab button
    this.Remove({ [`${tabPage.name}_button`]: "" });

    this._tabCount--;
  }
}
