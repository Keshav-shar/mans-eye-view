// Fills the static toolbar buttons with icons before the app loads.
import { icon } from './dom.js';

const map = {
  'btn-new-root': ['plus', 15],
  'btn-import': ['upload', 15],
  'btn-export': ['download', 15],
  'btn-side': ['menu', 16],
  'btn-undo': ['undo', 16],
  'btn-palette': ['search', 16],
};
for (const [id, [name, size]] of Object.entries(map)) {
  const el = document.getElementById(id);
  if (el) el.prepend(icon(name, size));
}
const ai = document.getElementById('btn-ai');
if (ai) ai.replaceChildren(icon('sparkle', 15), document.createTextNode('AI'));
