import { useState } from "react";
import { createPortal } from "react-dom";

export default function CreateRoomModal({ onClose, onCreate }) {
  const [name, setName] = useState("Movie Night");
  const [visibility, setVisibility] = useState("private");

  async function submit(event) {
    event.preventDefault();
    await onCreate(name, { visibility });
    onClose();
  }

  return createPortal(
    <div className="modal-backdrop">
      <form className="modal glass" onSubmit={submit}>
        <h2>Create room</h2>
        <label>
          Room name
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label>
          Visibility
          <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            <option value="private">Private invite room</option>
            <option value="public">Public room</option>
          </select>
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
