import { useState } from "react";
import { ClipboardPaste } from "lucide-react";

export default function JoinRoomForm({ onJoin }) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (code.trim()) await onJoin(code);
  }

  async function pasteCode() {
    const text = await (window.havyn?.clipboard?.readText
      ? Promise.resolve(window.havyn.clipboard.readText())
      : navigator.clipboard?.readText().catch(() => ""));
    if (text) {
      setCode(text.replace(/^havyn:\/\/room\//i, "").trim().toUpperCase());
      setNote("Room code pasted");
      window.setTimeout(() => setNote(""), 1800);
    } else {
      setNote("Clipboard is empty");
      window.setTimeout(() => setNote(""), 1800);
    }
  }

  return (
    <div className="join-form-wrap">
      <form className="join-form" onSubmit={submit}>
        <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ROOMCODE" />
        <button className="icon-button" type="button" title="Paste room code" onClick={pasteCode}><ClipboardPaste size={17} /></button>
        <button className="primary-button" type="submit">Join</button>
      </form>
      {note && <div className="action-note">{note}</div>}
    </div>
  );
}
