# Improvement Tracker

## Scope

First pass:

- Baseline current payload size.
- Add lightweight identity mapping.
- Optimize payload by default.
- Leave consent UI for Vũ Hào.

Backlog:

- S3 upload after local flow is stable.
- Mentor dashboard over `manifest.json` / S3 objects.

## Todo

- [x] Baseline current export size and event mix.
- [x] Wire student label into session identity.
- [x] Keep compact event payloads by default.
- [x] Preserve WebM recordings as the main playback artifact.
- [x] Implement backend server for automated uploads.
- [x] Capture remote audio tracks (Mentor) from student side.
- [x] Implement exponential backoff for upload retries.
- [ ] Add S3 upload after local flow is stable.
- [ ] Add mentor dashboard after storage is ready (TeenCareWork Project).
- [ ] Implement load testing with 40+ concurrent sessions.
- [ ] Add consent UI in a separate slice.

## Notes

- The 200MB JSON export is caused by large event payloads, not just session length.
- Default export should favor metadata, thumbnails, and compressed media.
- Full raw data should be opt-in only.