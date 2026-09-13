(() => {
  const endpoint = "http://127.0.0.1:47123/state";
  let last = "";

  function send() {
    const video = document.querySelector("video");
    const title = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim();
    const artist = document.querySelector("ytd-channel-name a")?.textContent?.trim();
    if (!video || !title || !video.duration || video.paused || video.ended) {
      if (last !== "stopped") fetch(endpoint, { method: "POST", body: JSON.stringify(null) }).catch(() => {});
      last = "stopped";
      return;
    }
    const state = { id: location.href.split("&")[0], url: location.href, title, artist,
      duration: video.duration, position: video.currentTime,
      art: `https://i.ytimg.com/vi/${new URLSearchParams(location.search).get("v")}/hqdefault.jpg`, playing: true };
    const key = JSON.stringify(state);
    if (key !== last) fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: key }).catch(() => {});
    last = key;
  }
  setInterval(send, 1000);
  send();
})();
