import { Mic, Phone, PhoneOff, Settings2, Video, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissableLayer } from "../hooks/useDismissableLayer";

export default function CallControls({ call, onDevicesOpenChange }) {
  const [devicesOpen, setDevicesOpen] = useState(false);
  const devicesButtonRef = useRef(null);
  const devicesMenuRef = useRef(null);
  const audioInputs = call.devices?.audioInputs || [];
  const videoInputs = call.devices?.videoInputs || [];

  function toggleDevices() {
    setDevicesOpen((value) => {
      const next = !value;
      onDevicesOpenChange?.(next);
      return next;
    });
  }

  const closeDevices = useCallback(() => {
    setDevicesOpen(false);
    onDevicesOpenChange?.(false);
  }, [onDevicesOpenChange]);

  useDismissableLayer(devicesOpen, [devicesButtonRef, devicesMenuRef], closeDevices);

  const devicePicker = devicesOpen ? createPortal(
    <div ref={devicesMenuRef} className="device-popover glass">
      <div className="device-popover-head">
        <strong>Call devices</strong>
        <button className="icon-button" type="button" title="Close devices" onClick={closeDevices}><X size={15} /></button>
      </div>
      <label>
        <span><Mic size={12} /> Microphone</span>
        <select
          value={call.selectedAudioDeviceId}
          onChange={(event) => call.selectAudioDevice(event.target.value)}
          title="Microphone"
        >
          {audioInputs.length ? audioInputs.map((device, index) => (
            <option value={device.deviceId} key={device.deviceId}>
              {device.label || `Microphone ${index + 1}`}
            </option>
          )) : <option value="">Default microphone</option>}
        </select>
      </label>
      <label>
        <span><Video size={12} /> Camera</span>
        <select
          value={call.selectedVideoDeviceId}
          onChange={(event) => call.selectVideoDevice(event.target.value)}
          title="Camera"
        >
          {videoInputs.length ? videoInputs.map((device, index) => (
            <option value={device.deviceId} key={device.deviceId}>
              {device.label || `Camera ${index + 1}`}
            </option>
          )) : <option value="">Default camera</option>}
        </select>
      </label>
    </div>,
    document.body
  ) : null;

  return (
    <div className="call-control-stack">
      <div className={`call-controls ${call.joined ? "is-joined" : ""}`}>
        {!call.joined ? (
          <button className="secondary-button compact-call-button" onClick={call.joinCall}><Phone size={16} /> Join</button>
        ) : (
          <>
            <button
              ref={devicesButtonRef}
              className={`icon-button ${devicesOpen ? "is-active" : ""}`}
              onClick={toggleDevices}
              title="Call devices"
            >
              <Settings2 size={17} />
            </button>
            <button className="icon-button danger-icon" onClick={call.leaveCall} title="Leave call"><PhoneOff size={17} /></button>
          </>
        )}
      </div>
      {devicePicker}
      {call.callError && <span className="call-error">{call.callError}</span>}
    </div>
  );
}
