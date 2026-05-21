import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

export default function CallControls({ call }) {
  const audioInputs = call.devices?.audioInputs || [];
  const videoInputs = call.devices?.videoInputs || [];

  return (
    <div className="call-control-stack">
      <div className={`call-controls ${call.joined ? "is-joined" : ""}`}>
        {!call.joined ? (
          <button className="secondary-button compact-call-button" onClick={call.joinCall}><Phone size={16} /> Join</button>
        ) : (
          <>
            <button className="icon-button" onClick={call.toggleMute} title={call.muted ? "Unmute mic" : "Mute mic"}>
              {call.muted ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
            <button className="icon-button" onClick={call.toggleCamera} title={call.cameraOff ? "Turn camera on" : "Turn camera off"}>
              {call.cameraOff ? <VideoOff size={17} /> : <Video size={17} />}
            </button>
            <button className="icon-button danger-icon" onClick={call.leaveCall} title="Leave call"><PhoneOff size={17} /></button>
          </>
        )}
      </div>
      <div className="device-selectors">
        <label>
          <Mic size={12} />
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
          <Video size={12} />
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
      </div>
      {call.callError && <span className="call-error">{call.callError}</span>}
    </div>
  );
}
