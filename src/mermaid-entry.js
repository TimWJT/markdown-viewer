// Built as its own file: mermaid is ~3.4 MB, more than ten times the rest of
// the app. It is fetched only when a document actually contains a diagram, so
// documents without one never pay for it.
import mermaid from 'mermaid';
window.__mermaid = mermaid;
