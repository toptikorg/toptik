export type VideoEvent = "video_start" | "video_complete";

/** Count one start per playback, not each pause/resume. A completed video can be played again. */
export function createVideoPlaybackTracker(send: (event: VideoEvent) => void) {
  let started = false;
  return {
    play() {
      if (started) return;
      started = true;
      send("video_start");
    },
    ended() {
      if (!started) return;
      started = false;
      send("video_complete");
    },
  };
}
