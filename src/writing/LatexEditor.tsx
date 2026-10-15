import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { autocompletion } from "@codemirror/autocomplete";
import { latex } from "codemirror-lang-latex";

export default function LatexEditor({ value, onChange, onSelection, readOnly = false }: {
  value: string;
  onChange(value: string): void;
  onSelection(selection: { text: string; from: number; to: number; lineStart: number; lineEnd: number }): void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  const selectionRef = useRef(onSelection);
  const editable = useRef(new Compartment());
  changeRef.current = onChange;
  selectionRef.current = onSelection;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), foldGutter(), history(), bracketMatching(), indentOnInput(),
          highlightActiveLine(), latex({ fileName: "document.tex", enableAutocomplete: true }),
          autocompletion(), keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          editable.current.of(EditorView.editable.of(!readOnly)),
          EditorView.updateListener.of(update => {
            if (update.docChanged) changeRef.current(update.state.doc.toString());
            if (update.selectionSet) {
              const range = update.state.selection.main;
              const selected = update.state.sliceDoc(range.from, range.to);
              const first = update.state.doc.lineAt(range.from).number;
              const last = update.state.doc.lineAt(range.to).number;
              selectionRef.current({ text: selected, from: range.from, to: range.to, lineStart: first, lineEnd: last });
            }
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "15px", backgroundColor: "transparent", color: "var(--text)" },
            ".cm-scroller": { fontFamily: 'Consolas, "Cascadia Code", "SFMono-Regular", monospace', overflow: "auto" },
            ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted)" },
            ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--teal) 7%, transparent)" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-content": { caretColor: "var(--teal)" },
            "&.cm-focused": { outline: "none" }
          })
        ]
      })
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { const compartment = editable.current; viewRef.current?.dispatch({ effects: compartment.reconfigure(EditorView.editable.of(!readOnly)) }); }, [readOnly]);
  return <div className="writingCodeEditor" ref={host} aria-label="LaTeX source editor" />;
}
