const controlsDiv = document.getElementById(`controls`);
const domBody = document.getElementById(`body`);
const domHead = document.getElementById(`head`);

const textBox1 = new uiTextBox();

controlsDiv.innerHTML += textBox1.html;
textBox1.DomLinkup();

const textBox2 = new uiTextBox();
textBox2.displayName = "New textbox!!!";

textBox1.AddControl(textBox2);

// Build event chaining to notify parent objects of new CSS and/or Javascript references.
domHead.innerHTML += textBox1.stylesHtml;
domBody.innerHTML += textBox1.sourcesHtml;