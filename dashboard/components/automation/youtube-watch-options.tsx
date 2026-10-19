export function youtubeReceiveSummary(options?: { releases?: boolean; community?: boolean }) {
  return ["動画・ショート・配信", options?.releases !== false && "リリース", options?.community === true && "コミュニティ投稿"].filter(Boolean).join("、");
}
