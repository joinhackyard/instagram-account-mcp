// Imported first by the CLI: hide Node's "SQLite is an experimental feature" notice. Built-in modules are
// loaded before any of our code runs, but warnings are delivered on a later tick through the 'warning'
// event, so filtering the listeners here still catches it. Every other warning is printed as usual.
const original = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w: Error) => {
  if (w.name === "ExperimentalWarning" && /SQLite/.test(w.message)) return;
  for (const l of original) l(w);
});
export {};
