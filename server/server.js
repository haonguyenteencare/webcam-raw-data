import cors from "cors";
import express from "express";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = __dirname;
const capturesRoot = path.join(projectRoot, "captures");
const port = Number(process.env.PORT || 8787);

const app = express();

app.use((req, res, next) => {
  console.log(`[NET] Incoming: ${req.method} ${req.url} (from: ${req.headers.origin || "unknown"})`);
  next();
});

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "250mb" }));
app.use("/captures", express.static(capturesRoot));

const sanitizeSegment = (value, fallback) => {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  const result = sanitized || fallback;
  console.log(`[UTILS] sanitizeSegment: "${value}" -> "${result}"`);
  return result;
};

const parseDataUrl = (dataUrl) => {
  console.log(`[UTILS] parseDataUrl: dataUrl length=${dataUrl?.length || 0}`);
  // Support complex MIME types like data:video/webm;codecs=opus;base64,...
  const match = /^data:(.*?)(;base64)?,(.*)$/s.exec(dataUrl || "");

  if (!match) {
    const preview = String(dataUrl || "").slice(0, 100);
    console.error(`[UTILS] parseDataUrl: Invalid data URL format. Preview: "${preview}..."`);
    throw new Error("Invalid data URL");
  }

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] || "";
  
  console.log(`[UTILS] parseDataUrl: mimeType=${mimeType}, isBase64=${isBase64}`);
  
  const buffer = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");

  return { buffer, mimeType };
};

const decodeNumberArray = (values, bytesPerValue) => {
  console.log(`[UTILS] decodeNumberArray: values.length=${values?.length || 0}, bytesPerValue=${bytesPerValue}`);
  if (!Array.isArray(values)) {
    return Buffer.alloc(0);
  }

  if (bytesPerValue === 4) {
    const buffer = Buffer.alloc(values.length * 4);

    values.forEach((value, index) => {
      buffer.writeFloatLE(Number(value) || 0, index * 4);
    });

    return buffer;
  }

  return Buffer.from(values.map((value) => Number(value) || 0));
};

const readManifest = async (manifestPath) => {
  console.log(`[FS] readManifest: ${manifestPath}`);
  try {
    const content = await readFile(manifestPath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[FS] readManifest: Could not read or parse manifest at ${manifestPath}: ${error.message}`);
    return null;
  }
};

const writeJson = async (filePath, value) => {
  console.log(`[FS] writeJson: ${filePath}`);
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    console.error(`[FS] writeJson error: ${filePath}`, error);
    throw error;
  }
};

const appendManifestEvents = async (sessionDir, sessionInfo, savedEvents) => {
  const manifestPath = path.join(sessionDir, "manifest.json");
  console.log(`[MANIFEST] appendManifestEvents: sessionDir=${sessionDir}, adding ${savedEvents.length} events`);
  
  const existing = await readManifest(manifestPath);
  const manifest =
    existing ||
    {
      formatVersion: 1,
      ...sessionInfo,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      eventCount: 0,
      events: [],
    };

  manifest.updatedAt = new Date().toISOString();
  manifest.eventCount += savedEvents.length;
  manifest.events.push(...savedEvents);

  await writeJson(manifestPath, manifest);
  console.log(`[MANIFEST] Updated manifest at ${manifestPath}. Total events: ${manifest.eventCount}`);

  return manifest;
};

const saveEvent = async (sessionDir, event, index) => {
  console.log(`[SAVE] saveEvent: type=${event.type}, sessionDir=${sessionDir}`);
  const payload = event.payload || {};
  const timestamp = Number(event.at || Date.now());
  const streamId = sanitizeSegment(payload.streamId, "stream");
  const baseName = `${timestamp}-${streamId}-${String(index).padStart(4, "0")}`;
  const saved = {
    type: event.type,
    at: timestamp,
    pageUrl: event.pageUrl,
    streamId: payload.streamId,
    files: {},
    metadata: {},
  };

  try {
    if (event.type === "video-batch") {
      const frameDir = path.join(sessionDir, "frames");

      await mkdir(frameDir, { recursive: true });

      const frames = payload.frames || [];
      const savedFrames = [];

      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const frameTimestamp = Number(frame.at || Date.now());
        const frameBaseName = `${frameTimestamp}-${streamId}-${String(index).padStart(4, "0")}-f${String(i).padStart(3, "0")}`;
        
        const savedFrame = {
          at: frameTimestamp,
          files: {},
          metadata: {
            width: frame.displayWidth,
            height: frame.displayHeight,
            allocationSize: frame.allocationSize,
            checksum: frame.checksum,
            sourceFormat: frame.sourceFormat,
            copiedFormat: frame.copiedFormat,
            rawSource: frame.rawSource,
            frameCount: frame.frameCount,
          },
        };

        if (frame.thumbnailDataUrl) {
          const { buffer } = parseDataUrl(frame.thumbnailDataUrl);
          const thumbnailPath = path.join(frameDir, `${frameBaseName}.jpg`);

          await writeFile(thumbnailPath, buffer);
          savedFrame.files.thumbnail = path.relative(sessionDir, thumbnailPath);
        }

        if (frame.rgbaDataUrl) {
          const { buffer } = parseDataUrl(frame.rgbaDataUrl);
          const rawPath = path.join(frameDir, `${frameBaseName}.rgba`);

          await writeFile(rawPath, buffer);
          savedFrame.files.rgba = path.relative(sessionDir, rawPath);
          savedFrame.metadata.rawByteSize = buffer.byteLength;
        }

        savedFrames.push(savedFrame);
      }

      saved.metadata.frames = savedFrames;
      saved.metadata.frameCount = savedFrames.length;
      return saved;
    }

    if (event.type === "video-frame") {
      const frameDir = path.join(sessionDir, "frames");

      await mkdir(frameDir, { recursive: true });

      if (payload.thumbnailDataUrl) {
        const { buffer } = parseDataUrl(payload.thumbnailDataUrl);
        const thumbnailPath = path.join(frameDir, `${baseName}.jpg`);

        await writeFile(thumbnailPath, buffer);
        saved.files.thumbnail = path.relative(sessionDir, thumbnailPath);
        console.log(`[SAVE] Saved thumbnail: ${thumbnailPath}`);
      }

      if (payload.rgbaDataUrl) {
        const { buffer } = parseDataUrl(payload.rgbaDataUrl);
        const rawPath = path.join(frameDir, `${baseName}.rgba`);

        await writeFile(rawPath, buffer);
        saved.files.rgba = path.relative(sessionDir, rawPath);
        saved.metadata.rawByteSize = buffer.byteLength;
        console.log(`[SAVE] Saved RGBA frame: ${rawPath} (${buffer.byteLength} bytes)`);
      }

      saved.metadata = {
        ...saved.metadata,
        width: payload.displayWidth,
        height: payload.displayHeight,
        allocationSize: payload.allocationSize,
        checksum: payload.checksum,
        sourceFormat: payload.sourceFormat,
        copiedFormat: payload.copiedFormat,
        rawSource: payload.rawSource,
        track: payload.track,
      };
      return saved;
    }

    if (event.type === "media-recording") {
      const recordingDir = path.join(sessionDir, "recordings", streamId);
      await mkdir(recordingDir, { recursive: true });

      if (payload.dataUrl) {
        const { buffer, mimeType } = parseDataUrl(payload.dataUrl);
        const ext = mimeType.split("/")[1]?.split(";")[0] || "webm";
        const chunkIndex = payload.chunkIndex !== undefined ? payload.chunkIndex : index;
        const filePath = path.join(recordingDir, `chunk-${String(chunkIndex).padStart(5, "0")}.${ext}`);

        await writeFile(filePath, buffer);
        saved.files.video = path.relative(sessionDir, filePath);
        saved.metadata.chunkIndex = chunkIndex;
        saved.metadata.mimeType = mimeType;
        saved.metadata.size = buffer.byteLength;
      }
      return saved;
    }

    if (event.type === "audio-recording") {
      const recordingDir = path.join(sessionDir, "recordings", streamId);
      await mkdir(recordingDir, { recursive: true });

      const chunkIndex = payload.chunkIndex !== undefined ? payload.chunkIndex : index;
      const baseName = `chunk-${String(chunkIndex).padStart(5, "0")}`;

      if (payload.samples && Array.isArray(payload.samples)) {
        const buffer = Buffer.from(new Float32Array(payload.samples).buffer);
        const filePath = path.join(recordingDir, `${baseName}.float32`);

        await writeFile(filePath, buffer);
        saved.files.samples = path.relative(sessionDir, filePath);
        saved.metadata.rawByteSize = buffer.byteLength;
      }

      saved.metadata.chunkIndex = chunkIndex;
      saved.metadata.sampleRate = payload.sampleRate;
      saved.metadata.channels = payload.channels;
      saved.metadata.sampleCount = payload.sampleCount;
      return saved;
    }

    if (event.type === "session-ended") {
      console.log(`[SESSION] Meeting ended: Session ${payload.sessionId} (Student: ${payload.studentLabel})`);
    }

    const eventDir = path.join(sessionDir, "events");

    await mkdir(eventDir, { recursive: true });

    const eventPath = path.join(eventDir, `${baseName}-${sanitizeSegment(event.type, "event")}.json`);

    await writeJson(eventPath, event);
    saved.files.event = path.relative(sessionDir, eventPath);
    saved.metadata = payload;
    console.log(`[SAVE] Saved generic event: ${eventPath}`);

    return saved;
  } catch (error) {
    console.error(`[SAVE] Error saving event type=${event.type} in ${sessionDir}:`, error);
    throw error;
  }
};

const findManifests = async (directory) => {
  console.log(`[FS] findManifests: Searching in ${directory}`);
  const manifests = [];

  try {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        manifests.push(...(await findManifests(entryPath)));
      } else if (entry.name === "manifest.json") {
        console.log(`[FS] findManifests: Found manifest at ${entryPath}`);
        manifests.push(entryPath);
      }
    }
  } catch (error) {
    console.error(`[FS] findManifests error in ${directory}:`, error);
    return manifests;
  }

  return manifests;
};

/**
 * Tìm và di chuyển thư mục session nếu nó đã tồn tại ở một vị trí khác (thường là unknown-meeting)
 */
async function findAndMoveSessionDir(sessionId, targetParentPath, sessionIdParam) {
  const targetDir = path.join(targetParentPath, sessionIdParam);
  
  // Nếu đã ở đúng vị trí rồi thì thôi
  try {
    await access(targetDir);
    return targetDir;
  } catch (e) {
    // Chưa ở đúng vị trí, đi tìm
  }

  try {
    const parents = await readdir(capturesRoot);
    for (const parent of parents) {
      const parentPath = path.join(capturesRoot, parent);
      const parentStat = await stat(parentPath);
      
      if (parentStat.isDirectory()) {
        const potentialDir = path.join(parentPath, sessionIdParam);
        try {
          await access(potentialDir);
          // Tìm thấy ở chỗ khác! Di chuyển nó về chỗ mới
          console.log(`[FS] Moving session ${sessionIdParam} from ${parent} to new location...`);
          await mkdir(targetParentPath, { recursive: true });
          await rename(potentialDir, targetDir);
          return targetDir;
        } catch (err) {
          // Không có ở đây
        }
      }
    }
  } catch (err) {
    console.error("[FS] Error while searching for existing session:", err);
  }

  return targetDir;
}

app.get("/health", (_request, response) => {
  console.log(`[HTTP] GET /health`);
  response.json({ ok: true, capturesRoot });
});

app.post("/api/capture/batch", async (request, response, next) => {
  try {
    const body = request.body || {};
    const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
    const studentId = sanitizeSegment(body.studentId, "unknown-student");
    const studentLabel = sanitizeSegment(body.studentLabel, "no-label");
    const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
    const events = Array.isArray(body.events) ? body.events : [];
    
    console.log(`[BATCH] Receiving ${events.length} events for session: ${sessionId} (Student: ${studentLabel})`);

    const studentFolderName = `${meetingId}_${studentId}_${studentLabel}`;
    const targetParentPath = path.resolve(capturesRoot, studentFolderName);
    
    // Tìm và di chuyển thư mục phiên cũ nếu cần
    const sessionDir = await findAndMoveSessionDir(sessionId, targetParentPath, sessionId);
    console.log(`[FS] Absolute session path: ${sessionDir}`);

    console.log(`[FS] Ensuring directory exists...`);
    try {
      await mkdir(sessionDir, { recursive: true });
      console.log(`[FS] Directory ready.`);
    } catch (fsError) {
      console.error(`[FS] Failed to create directory: ${fsError.message}`);
      throw fsError;
    }

    const savedEvents = [];

    for (let index = 0; index < events.length; index += 1) {
      const saved = await saveEvent(sessionDir, events[index], index);
      savedEvents.push(saved);
    }

    const manifest = await appendManifestEvents(
      sessionDir,
      {
        meetingId,
        studentId,
        sessionId,
        pageUrl: body.pageUrl,
        userAgent: body.userAgent,
      },
      savedEvents,
    );

    console.log(`[SUCCESS] Saved batch. Total events in manifest: ${manifest.eventCount}`);

    response.json({
      ok: true,
      meetingId,
      studentId,
      sessionId,
      savedEventCount: savedEvents.length,
      totalEventCount: manifest.eventCount,
      sessionPath: path.relative(projectRoot, sessionDir),
    });
  } catch (error) {
    console.error(`[ERROR] Batch processing failed: ${error.message}`);
    next(error);
  }
});

app.get("/api/sessions", async (_request, response, next) => {
  console.log(`[HTTP] GET /api/sessions`);
  try {
    const manifestPaths = await findManifests(capturesRoot);
    const sessions = [];

    for (const manifestPath of manifestPaths) {
      const manifest = await readManifest(manifestPath);
      const stats = await stat(manifestPath);

      if (manifest) {
        sessions.push({
          meetingId: manifest.meetingId,
          studentId: manifest.studentId,
          sessionId: manifest.sessionId,
          startedAt: manifest.startedAt,
          updatedAt: manifest.updatedAt,
          eventCount: manifest.eventCount,
          manifestPath: path.relative(capturesRoot, manifestPath),
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    }

    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    console.log(`[HTTP] GET /api/sessions: Returning ${sessions.length} sessions`);
    response.json({ ok: true, sessions });
  } catch (error) {
    console.error(`[HTTP] GET /api/sessions: Error:`, error);
    next(error);
  }
});

app.get("/api/sessions/:sessionId", async (request, response, next) => {
  const { sessionId } = request.params;
  console.log(`[HTTP] GET /api/sessions/${sessionId}`);
  try {
    const manifestPaths = await findManifests(capturesRoot);
    const target = sanitizeSegment(sessionId, "");

    for (const manifestPath of manifestPaths) {
      const manifest = await readManifest(manifestPath);

      if (manifest?.sessionId === target) {
        console.log(`[HTTP] GET /api/sessions/${sessionId}: Found session`);
        response.json({ ok: true, session: manifest });
        return;
      }
    }

    console.warn(`[HTTP] GET /api/sessions/${sessionId}: Session not found`);
    response.status(404).json({ ok: false, reason: "Session not found" });
  } catch (error) {
    console.error(`[HTTP] GET /api/sessions/${sessionId}: Error:`, error);
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ ok: false, reason: error.message });
});

await mkdir(capturesRoot, { recursive: true });

app.listen(port, () => {
  console.log(`Meet capture API listening on http://localhost:${port}`);
  console.log(`Captures root: ${capturesRoot}`);
});
