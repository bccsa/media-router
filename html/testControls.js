const controlsDiv = document.getElementById(`controls`);
// const domBody = document.getElementById(`body`);
const domHead = document.getElementsByTagName(`head`)[0];

// Top level parent control
const textBox1 = new uiTextBox();
controlsDiv.innerHTML += textBox1.html;
// textBox1.DomLinkup();
textBox1.styles.forEach(ref => {
    domHead.innerHTML += `<link rel="stylesheet" href="${ref}"></link>`;
})

// Child controls
// const textBox2 = new uiTextBox();
// textBox2.value = "Hallo Etienne";
// textBox1.AddControl(textBox2);

