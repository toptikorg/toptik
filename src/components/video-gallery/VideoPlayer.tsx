"use client";

import { useState } from "react";
import { createVideoPlaybackTracker, type VideoEvent } from "@/lib/video-playback";

type AnalyticsWindow = Window & { gtag?: (...args: unknown[]) => void };

function track(name: VideoEvent, slug: string) {
  const analytics = window as AnalyticsWindow;
  // Reuse the existing gallery Google tag and consent configuration.
  // Do not initialize another tag or include URLs with query parameters.
  analytics.gtag?.("event", name, { video_id: slug, video_provider: "html5" });
}

export function VideoPlayer({ file, slug, title }: { file: string; slug: string; title: string }) {
  const [tracker] = useState(() => createVideoPlaybackTracker((event) => track(event, slug)));
  return (
    <video
      controls
      playsInline
      preload="none"
      poster={`/videos/${file}.webp`}
      aria-label={`סרטון: ${title}`}
      onPlay={() => tracker.play()}
      onEnded={() => tracker.ended()}
    >
      <source src={`/videos/${file}.mp4`} type="video/mp4" />
      <track kind="captions" src={`/videos/${file}.he.vtt`} srcLang="he" label="עברית" />
      הדפדפן אינו תומך בהצגת הסרטון. ניתן לקרוא את התמלול שמתחתיו.
    </video>
  );
}
