import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 录音播放器：支持音文联动的跳转（seekRequest 会切换播放位置并自动播放）
export function AudioPlayer({
  meetingId,
  audioPath,
  seekRequest,
  onTimeUpdate,
}: {
  meetingId: string;
  audioPath: string;
  seekRequest: { time: number; nonce: number } | null;
  onTimeUpdate: (seconds: number) => void;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentPos, setCurrentPos] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [waitingForMetadata, setWaitingForMetadata] = useState<{
    time: number;
    nonce: number;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!audioPath) {
      setAudioUrl(null);
      return;
    }
    setLoading(true);
    setCurrentPos(0);
    setIsPlaying(false);
    setWaitingForMetadata(null);
    void invoke<string>("get_recording_path", { meetingId })
      .then((path) => setAudioUrl(convertFileSrc(path)))
      .catch(() => setAudioUrl(null))
      .finally(() => setLoading(false));
  }, [meetingId, audioPath]);

  // 音文联动：收到 seekRequest 后跳转播放位置并自动播放
  useEffect(() => {
    if (!seekRequest) return;
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      // 元数据尚未加载完成，先记下目标时间，等 onLoadedMetadata 触发后再应用
      setWaitingForMetadata(seekRequest);
      return;
    }
    const target = Math.max(0, Math.min(totalDuration, seekRequest.time));
    audio.currentTime = target;
    setCurrentPos(target);
    onTimeUpdate(target);
    void audio.play().catch(() => {
      // 浏览器可能拒绝自动播放，忽略错误；用户可手动点击播放
    });
  }, [seekRequest, audioUrl, totalDuration, onTimeUpdate]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  const handleSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !totalDuration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * totalDuration;
  };

  const handleTimeUpdate = (event: React.SyntheticEvent<HTMLAudioElement>) => {
    const seconds = event.currentTarget.currentTime;
    setCurrentPos(seconds);
    onTimeUpdate(seconds);
  };

  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLAudioElement>) => {
    const duration = event.currentTarget.duration;
    setTotalDuration(duration);
    // 处理等待元数据时挂起的跳转请求
    if (waitingForMetadata) {
      const target = Math.max(0, Math.min(duration, waitingForMetadata.time));
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = target;
        setCurrentPos(target);
        onTimeUpdate(target);
        void audio.play().catch(() => undefined);
      }
      setWaitingForMetadata(null);
    }
  };

  const progress = totalDuration > 0 ? (currentPos / totalDuration) * 100 : 0;

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
      />
      <button className="audio-play-btn" onClick={togglePlay} disabled={loading || !audioUrl}>
        {loading ? null : isPlaying ? (
          <Pause size={18} fill="currentColor" />
        ) : (
          <Play size={18} fill="currentColor" />
        )}
      </button>
      <span className="audio-time">{formatTime(currentPos)}</span>
      <div className="audio-seek" onClick={handleSeek}>
        <div className="audio-progress" style={{ width: `${progress}%` }} />
      </div>
      <span className="audio-time">{formatTime(totalDuration)}</span>
    </div>
  );
}
