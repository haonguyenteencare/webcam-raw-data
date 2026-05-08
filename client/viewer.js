const fileInput = document.querySelector("#file");
const summaryElement = document.querySelector("#summary");
const framesElement = document.querySelector("#frames");
const audioElement = document.querySelector("#audio");
const recordingsElement = document.querySelector("#recordings");

const makeCard = (metaText) => {
  const card = document.createElement("article");
  const meta = document.createElement("div");

  card.className = "card";
  meta.className = "meta";
  meta.textContent = metaText;

  return { card, meta };
};

const drawAudio = (samples) => {
  const canvas = document.createElement("canvas");
  const width = 320;
  const height = 120;
  const context = canvas.getContext("2d");

  canvas.width = width;
  canvas.height = height;

  context.fillStyle = "#111827";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#7dd3fc";
  context.lineWidth = 2;
  context.beginPath();

  samples.forEach((sample, index) => {
    const x = (index / Math.max(1, samples.length - 1)) * width;
    const y = height / 2 - sample * height * 14;

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });

  context.stroke();

  return canvas;
};

const encodeWav = (samples, sampleRate) => {
  const bytesPerSample = 2;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  let offset = 0;

  const writeString = (value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  };

  writeString("RIFF");
  view.setUint32(offset, 36 + samples.length * bytesPerSample, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * bytesPerSample, true);
  offset += 4;
  view.setUint16(offset, bytesPerSample, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, samples.length * bytesPerSample, true);
  offset += 4;

  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
};

const renderSession = (session) => {
  const videoFrames = session.events.filter((event) => event.type === "video-frame");
  const audioRecordings = session.events.filter((event) => event.type === "audio-recording");
  const mediaRecordings = session.events.filter((event) => event.type === "media-recording");
  const audioChunks = session.events.filter((event) => event.type === "audio-samples");

  summaryElement.textContent = `${session.id}: ${videoFrames.length} video frame sample(s), ${audioRecordings.length} PCM audio preview(s), ${mediaRecordings.length} WebM recording chunk(s), ${audioChunks.length} audio chunk event(s), ${session.startedAt}`;
  framesElement.textContent = "";
  audioElement.textContent = "";
  recordingsElement.textContent = "";
  framesElement.className = "grid";
  audioElement.className = "grid";
  recordingsElement.className = "grid";

  for (const event of videoFrames) {
    const { card, meta } = makeCard(
      `${new Date(event.at).toLocaleTimeString()} - ${event.payload.displayWidth}x${event.payload.displayHeight} - ${event.payload.checksum}`,
    );

    if (event.payload.thumbnailDataUrl) {
      const image = document.createElement("img");

      image.src = event.payload.thumbnailDataUrl;
      image.alt = "Captured frame";
      card.append(image);
    }

    card.append(meta);
    framesElement.append(card);
  }

  for (const event of audioRecordings) {
    const audio = document.createElement("audio");
    const { card, meta } = makeCard(
      `${new Date(event.at).toLocaleTimeString()} - ${event.payload.sampleCount} samples @ ${event.payload.sampleRate}Hz`,
    );

    if (Array.isArray(event.payload.samples) && event.payload.samples.length > 0) {
      const blob = encodeWav(event.payload.samples || [], event.payload.sampleRate);

      audio.controls = true;
      audio.src = URL.createObjectURL(blob);
      card.append(audio);
    } else {
      const warning = document.createElement("div");
      warning.className = "warning-text";
      warning.textContent = "⚠ No raw PCM data (Enable 'Research Raw Mode' in popup before recording)";
      card.append(warning);
    }

    card.append(meta);
    audioElement.append(card);
  }

  for (const event of mediaRecordings) {
    const media = document.createElement(event.payload.hasVideo ? "video" : "audio");
    const { card, meta } = makeCard(
      `${new Date(event.at).toLocaleTimeString()} - ${event.payload.mimeType} - ${Math.round(event.payload.size / 1024)}KB`,
    );

    media.controls = true;
    media.src = event.payload.dataUrl;
    card.append(media, meta);
    recordingsElement.append(card);
  }

  if (audioChunks.length > 0) {
    for (const event of audioChunks.slice(0, audioRecordings.length ? 12 : audioChunks.length)) {
      const { card, meta } = makeCard(
        `${new Date(event.at).toLocaleTimeString()} - ${event.payload.sampleCount} samples @ ${event.payload.sampleRate}Hz - peak ${event.payload.peak}`,
      );

      card.append(drawAudio(event.payload.firstSamples || []), meta);
      audioElement.append(card);
    }
  }

  if (videoFrames.length === 0 && audioRecordings.length === 0 && mediaRecordings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No media events found. Ensure 'Consent' and 'Research Mode' were enabled in the extension popup during the meeting.";
    framesElement.parentElement.append(empty);
  }
};

const loadLocalSession = async () => {
  const { events = [] } = await chrome.storage.local.get({ events: [] });
  if (events.length > 0) {
    renderSession({
      id: "Local Storage Session",
      events,
      startedAt: new Date(events[0].at).toLocaleString(),
    });
  }
};

window.addEventListener("load", loadLocalSession);

fileInput.addEventListener("change", async () => {
  const [file] = fileInput.files;

  if (!file) {
    return;
  }

  const text = await file.text();
  const session = JSON.parse(text);

  renderSession(session);
});
