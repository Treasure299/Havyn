import { ChevronLeft, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function ChatPanel({
  messages,
  onSend,
  className = "",
  collapsible = false,
  collapsed = false,
  onToggle,
  onFreshMessage,
  currentUserId
}) {
  const [draft, setDraft] = useState("");
  const [isFresh, setIsFresh] = useState(false);
  const lastMessageCountRef = useRef(messages.length);

  useEffect(() => {
    if (messages.length > lastMessageCountRef.current) {
      const newestMessage = messages[messages.length - 1];
      const senderId = newestMessage?.userId || newestMessage?.senderId;
      const isIncomingUserMessage = Boolean(
        senderId &&
        currentUserId &&
        senderId !== currentUserId &&
        newestMessage?.type !== "system"
      );
      lastMessageCountRef.current = messages.length;
      if (isIncomingUserMessage) {
        setIsFresh(true);
        onFreshMessage?.();
        const timer = window.setTimeout(() => setIsFresh(false), 4200);
        return () => window.clearTimeout(timer);
      }
      setIsFresh(false);
      return undefined;
    }
    lastMessageCountRef.current = messages.length;
    return undefined;
  }, [messages, currentUserId, onFreshMessage]);

  function submit(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  }

  return (
    <>
      {collapsible ? (
        <button
          className={`chat-edge-toggle ${collapsed ? "is-collapsed" : "is-open"} ${isFresh ? "has-new-message" : ""}`}
          type="button"
          onClick={onToggle}
          title={collapsed ? "Open chat" : "Collapse chat"}
        >
          {collapsed ? <ChevronLeft size={20} /> : <X size={17} />}
        </button>
      ) : null}
    <section className={`chat-panel glass ${className} ${isFresh ? "has-new-message" : ""} ${collapsible ? "is-collapsible" : ""} ${collapsed ? "is-collapsed" : ""}`}>
      <div className="chat-panel-inner">
      <div className="chat-heading">
        <h2>Chat</h2>
        {collapsible && (
          <button className="icon-button" type="button" onClick={onToggle} title="Collapse chat">
            {collapsed ? <ChevronLeft size={17} /> : <X size={17} />}
          </button>
        )}
      </div>
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
      </div>
    </section>
    </>
  );
}
