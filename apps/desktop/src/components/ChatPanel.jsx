import { Send } from "lucide-react";
import { useState } from "react";

export default function ChatPanel({ messages, onSend }) {
  const [draft, setDraft] = useState("");

  function submit(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  }

  return (
    <section className="chat-panel glass">
      <h2>Chat</h2>
      <div className="message-list">
        {messages.map((message) => (
          <div className={`message ${message.type === "system" ? "system-message" : ""}`} key={message.id}>
            <span>{message.displayName}</span>
            <p>{message.message}</p>
          </div>
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message the room" />
        <button className="icon-button" type="submit" title="Send"><Send size={17} /></button>
      </form>
    </section>
  );
}
