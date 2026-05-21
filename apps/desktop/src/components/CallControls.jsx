import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

export default function CallControls({ call }) {
  return (
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
      {call.callError && <span className="call-error">{call.callError}</span>}
    </div>
  );
}
