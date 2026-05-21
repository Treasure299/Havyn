import { useState } from "react";
import { createPortal } from "react-dom";

export default function CreateRoomModal({ onClose, onCreate }) {
  const [name, setName] = useState("Movie Night");

  async function submit(event) {
    event.preventDefault();
    await onCreate(name);
    onClose();
  }

  return createPortal(
    <div className="modal-backdrop">
      <form className="modal glass" onSubmit={submit}>
        <h2>Create private room</h2>
        <label>
          Room name
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit">Create</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
