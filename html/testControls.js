const controlsDiv = document.getElementById(`controls`);
// const domBody = document.getElementById(`body`);
const domHead = document.getElementsByTagName(`head`)[0];

let _abortController = new AbortController();
document.addEventListener("DOMContentLoaded", _init, {
  signal: _abortController.signal,
});

function _init() {
  _abortController.abort();

  const textBox1 = new uiTextBox();
  textBox1.displayName = "Name";
  controlsDiv.innerHTML += textBox1.html;
  textBox1.value = " etienne fuh";

  textBox1.DomLinkup();

  // Child controls
  const textBox2 = new uiTextBox();
  textBox2.value = "test value fuh";
  textBox1.AddControl(textBox2);

  textBox2.DomLinkup();

  // New ui control

  const textBox3 = new uiTextBox();
  textBox3.displayName = "Class";
  controlsDiv.innerHTML += textBox3.html;
  textBox3.value = "AB Testing";

  textBox3.DomLinkup();
}

// Top level parent control

//
