import createDebug from "debug";
import http2 from "http2";

import { splitInitSegment, splitMediaSegment } from "./CMAFTracks";
import { BufferUploadCommandType, CMAFError } from "./SecureVideoTypes";

import type { CMAFTrack, CMAFTrackSegment } from "./CMAFTracks";
import type { BufferUploadCommandRequest } from "./SecureVideoTypes";
import type { CMAFRecordingDelegate, CMAFSegment, SecureVideoIngestCredentials } from "../controller/SecureVideoController";

const debug = createDebug("HAP-NodeJS:SecureVideo:Ingest");

const FIRST_SEGMENT_NUMBER = 1001;
const DEFAULT_SEGMENT_DURATION_SECONDS = 2;
// Matter 1.6.1 Push AV Stream Transport 11.7.1.6: a session lasts at most five minutes and at least two segments
const MAX_SESSION_SECONDS = 300;
// DASH-IF ingest 5.3: a failed transfer is sent again on a new connection
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";
const INIT_CONTENT_TYPE = "video/mp4";
const SEGMENT_CONTENT_TYPE = "video/iso.segment";

/**
 * Everything the ingest needs from the controller: the negotiated credentials, the persisted session number and the
 * event reporters. Keeps the credential and event handling internal to the controller.
 *
 * @group Camera Secure Video
 */
export interface CMAFIngestContext {
  /** sent as User-Agent, DASH-IF ingest asks for brand name and version */
  userAgent: string;
  credentials(): SecureVideoIngestCredentials;
  /** the number of the next CMAF session: starts at 1 for a new publishing point, persisted, never reused */
  nextSessionNumber(): bigint;
  reportSessionStart(cmafSessionId: bigint): void;
  reportSessionStop(cmafSessionId: bigint): void;
  /** `detail` names the failed request or the transport error, for logging only */
  reportError(cmafSessionId: bigint, error: CMAFError, detail?: string): void;
}

interface UploadSession {
  /** number of the first CMAF session of the clip, the hub learns it from the upload command response */
  clipId: bigint;
  abort: AbortController;
  /** no further hub command is expected, the session is dropped once the upload ends */
  finalize: boolean;
  /** the hub sent stop, the upload ends with the fragments already received */
  stopRequested: boolean;
  finished: boolean;
}

interface CMAFSession {
  number: bigint;
  /** publishing point path plus `session_<number>/` */
  prefix: string;
  startedAt: number;
  seconds: number;
  /** uploaded segment durations per track id */
  durations: Map<number, number[]>;
  /** tracks whose initial media playlist was accepted; only those get a final playlist */
  opened: Set<number>;
  failed: boolean;
  ended: boolean;
}

interface PreparedSegment {
  parts: CMAFTrackSegment[];
  /** seconds, the longest track */
  duration: number;
}

interface PutResult {
  status: number;
  /** first bytes of the response body, the ingest edge explains rejections there */
  body: string;
  /** response headers as name=value pairs, they carry the request id Apple asks for */
  headers: string;
}

class IngestConnection {
  private client?: http2.ClientHttp2Session;

  constructor(private readonly origin: string, private readonly options: http2.SecureClientSessionOptions) {}

  session(): http2.ClientHttp2Session {
    if (!this.client || this.client.closed || this.client.destroyed) {
      this.client = http2.connect(this.origin, this.options);
      this.client.on("error", error => debug("http2 session error: %s", error.message));
    }
    return this.client;
  }

  /** closes the current connection once its streams are done, the next request opens a new one */
  renew(): void {
    this.client?.close();
    this.client = undefined;
  }
}

function put(client: http2.ClientHttp2Session, path: string, body: Buffer, contentType: string, headers: http2.OutgoingHttpHeaders): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const request = client.request({
      ":method": "PUT",
      ":path": path,
      "content-type": contentType,
      "content-length": body.length,
      ...headers,
    });

    let status = 0;
    let summary = "";
    const chunks: Buffer[] = [];
    request.on("response", responseHeaders => {
      status = Number(responseHeaders[":status"]);
      summary = Object.entries(responseHeaders)
        .filter(([name]) => !name.startsWith(":"))
        .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(",") : value}`)
        .join(" ");
    });
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8").slice(0, 512);
      debug("PUT %s (%d bytes) -> %d %s %s", path.slice(path.indexOf("session_")), body.length, status, response, summary);
      resolve({ status, body: response, headers: summary });
    });
    request.on("error", reject);
    request.end(body);
  });
}

// appends the parts of a segment to the one before it, a CMAF segment may hold several fragments
function appendSegment(target: PreparedSegment, source: PreparedSegment): void {
  for (const part of source.parts) {
    const index = target.parts.findIndex(existing => existing.track === part.track);
    if (index < 0) {
      target.parts.push(part);
      continue;
    }
    const existing = target.parts[index];
    target.parts[index] = {
      ...existing,
      data: Buffer.concat([existing.data, part.data]),
      duration: existing.duration + part.duration,
      samples: existing.samples + part.samples,
    };
  }
  target.duration = target.parts.reduce((longest, part) => Math.max(longest, part.duration), 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Formats a segment duration for the `#EXTINF` tag and the `X-EXTINF-duration` header.
 *
 * @group Camera Secure Video
 */
export function formatDuration(seconds: number): string {
  return seconds.toFixed(5);
}

function quote(value: string): string {
  return `"${value}"`;
}

/**
 * Builds the HLS multivariant playlist of a CMAF session (RFC 8216): the video track as the variant, audio tracks as
 * renditions. BANDWIDTH and FRAME-RATE come from the first segment, a representative period of the session.
 *
 * @group Camera Secure Video
 */
export function buildMultivariantPlaylist(tracks: CMAFTrack[], first: CMAFTrackSegment[]): string {
  const video = tracks.find(track => track.kind === "video");
  if (!video) {
    throw new Error("a CMAF session needs a video track");
  }
  const audio = tracks.filter(track => track.kind === "audio");
  const bandwidth = Math.ceil(first.reduce((sum, part) => sum + (part.duration > 0 ? part.data.length * 8 / part.duration : 0), 0));
  const firstVideo = first.find(part => part.track === video);
  const codecs = [video.codecs, ...audio.slice(0, 1).map(track => track.codecs)];

  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  audio.forEach((track, index) => {
    const attributes = [
      "TYPE=AUDIO",
      `GROUP-ID=${quote("audio")}`,
      `NAME=${quote(track.name)}`,
      `DEFAULT=${index === 0 ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      ...(track.channels ? [`CHANNELS=${quote(String(track.channels))}`] : []),
      `URI=${quote(`${track.name}/index.m3u8`)}`,
    ];
    lines.push(`#EXT-X-MEDIA:${attributes.join(",")}`);
  });

  const variant = [
    `BANDWIDTH=${bandwidth}`,
    // CODECS lists every codec of the variant, it is left out when one of them is unknown
    ...(codecs.every(Boolean) ? [`CODECS=${quote(codecs.join(","))}`] : []),
    ...(video.width && video.height ? [`RESOLUTION=${video.width}x${video.height}`] : []),
    ...(firstVideo && firstVideo.duration > 0 ? [`FRAME-RATE=${(firstVideo.samples / firstVideo.duration).toFixed(3)}`] : []),
    ...(audio.length ? [`AUDIO=${quote("audio")}`] : []),
  ];
  lines.push(`#EXT-X-STREAM-INF:${variant.join(",")}`, `${video.name}/index.m3u8`, "");
  return lines.join("\n");
}

/**
 * Builds the HLS media playlist of a track. Without durations it is the initial playlist that opens the track, with
 * them the final one that lists every uploaded segment and closes it (Matter 1.6.1 11.7.1.8.2).
 *
 * @group Camera Secure Video
 */
export function buildMediaPlaylist(track: CMAFTrack, targetDuration: number, durations?: number[]): string {
  const target = Math.max(targetDuration, ...(durations ?? []).map(Math.round));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI=${quote(`${track.name}.init`)}`,
  ];
  if (durations) {
    durations.forEach((duration, index) => {
      lines.push(`#EXTINF:${formatDuration(duration)},`, `segment_${FIRST_SEGMENT_NUMBER + index}.m4s`);
    });
    lines.push("#EXT-X-ENDLIST");
  }
  lines.push("");
  return lines.join("\n");
}

function trailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function toPem(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * Maps a publishing point HTTP status to the CMAF error reported to the HomeKit HomeHub.
 *
 * @group Camera Secure Video
 */
export function mapStatus(status: number): CMAFError {
  switch (status) {
  case 400:
    return CMAFError.HTTP_BAD_REQUEST;
  case 401:
  case 403:
    return CMAFError.HTTP_INVALID_TOKEN;
  case 404:
    return CMAFError.HTTP_NOT_FOUND;
  case 412:
    return CMAFError.HTTP_INIT_MISSING;
  case 415:
    return CMAFError.HTTP_UNSUPPORTED_MEDIA_TYPE;
  case 503:
    return CMAFError.HTTP_SERVICE_UNAVAILABLE;
  default:
    return status >= 500 ? CMAFError.HTTP_INTERNAL_SERVER_ERROR : CMAFError.UNKNOWN;
  }
}

/**
 * Uploads HomeKit Secure Video clips to the CMAF publishing point following DASH-IF ingest interface 2 for HLS with the
 * deviations of the Matter 1.6.1 Push AV Stream Transport cluster. The media is supplied by a
 * {@link CMAFRecordingDelegate} as muxed fMP4; this splits it into one CMAF track per media type and PUTs the playlists
 * and segments over HTTP/2 with the client certificate the controller manages. Segments are uploaded in the clear.
 *
 * @group Camera Secure Video
 */
export class CMAFIngest {
  private readonly sessions = new Map<bigint, UploadSession>();

  constructor(private readonly delegate: CMAFRecordingDelegate, private readonly context: CMAFIngestContext) {}

  handleUploadCommand(request: BufferUploadCommandRequest): bigint {
    const existing = this.sessions.get(request.sessionId);

    if (request.command === BufferUploadCommandType.STOP) {
      if (existing) {
        existing.finalize = true;
        existing.stopRequested = true;
        if (existing.finished) {
          this.sessions.delete(request.sessionId);
        }
        return existing.clipId;
      }
      debug("stop for unknown session %s", request.sessionId);
      return 0n;
    }

    if (existing) {
      return existing.clipId;
    }

    const session: UploadSession = {
      clipId: this.context.nextSessionNumber(),
      abort: new AbortController(),
      finalize: request.command === BufferUploadCommandType.START_AND_STOP,
      stopRequested: false,
      finished: false,
    };
    this.sessions.set(request.sessionId, session);

    // the session ends with the hub's stop command, which may arrive after the upload itself ended
    this.upload(request, session).finally(() => {
      session.finished = true;
      if (session.finalize) {
        this.sessions.delete(request.sessionId);
      }
    });
    return session.clipId;
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      session.abort.abort();
    }
    this.sessions.clear();
  }

  private async upload(request: BufferUploadCommandRequest, session: UploadSession): Promise<void> {
    const { publishingPoint, privateKey, clientCertificate, ca } = this.context.credentials();
    if (!publishingPoint || !privateKey || !clientCertificate) {
      debug("upload ignored, ingest is not provisioned");
      this.context.reportError(session.clipId, CMAFError.INVALID_STATE);
      return;
    }

    const url = new URL(publishingPoint.url);
    const base = trailingSlash(url.pathname);
    const connection = new IngestConnection(url.origin, {
      key: privateKey,
      cert: [toPem(clientCertificate), ...(ca ? [toPem(ca)] : [])].join(""),
      ca: publishingPoint.serverCACertificates.map(toPem),
    });

    const clip = this.delegate.streamClip({ command: request, signal: session.abort.signal });
    let tracks: CMAFTrack[] = [];
    let targetDuration = 0;
    let current: CMAFSession | undefined;
    try {
      const first = await clip.next();
      if (first.done || first.value.type !== "init") {
        throw new Error("delegate did not yield an init segment first");
      }
      tracks = splitInitSegment(first.value.data);
      if (!tracks.some(track => track.kind === "video")) {
        throw new Error("init segment without a video track");
      }

      const prepare = (segment: CMAFSegment): PreparedSegment => {
        const fallback = segment.duration ?? DEFAULT_SEGMENT_DURATION_SECONDS;
        const parts = splitMediaSegment(segment.data, tracks).map(part => (part.duration > 0 ? part : { ...part, duration: fallback }));
        return { parts, duration: parts.reduce((longest, part) => Math.max(longest, part.duration), 0) };
      };

      // two segments of lookahead: whether the segment after the current one is the last decides where a session ends
      const window: PreparedSegment[] = [];
      let ended = false;
      const fill = async () => {
        while (!ended && window.length < 3) {
          if (session.stopRequested) {
            ended = true;
            break;
          }
          const next = await clip.next();
          if (next.done) {
            ended = true;
          } else if (next.value.type === "media") {
            const prepared = prepare(next.value);
            const video = prepared.parts.find(part => part.track.kind === "video");
            const previous = window.at(-1);
            // every segment starts with a sync sample (CMAF, EXT-X-INDEPENDENT-SEGMENTS), a fragment that does not
            // continues the segment before it
            if (previous && video && !video.startsWithSync) {
              appendSegment(previous, prepared);
            } else {
              window.push(prepared);
            }
            ended = !!next.value.last;
          }
        }
      };

      let reserved: bigint | undefined = session.clipId;
      for (;;) {
        await fill();
        const segment = window.shift();
        if (!segment) {
          break;
        }

        const lastFollower = ended && window.length === 1 ? window[0] : undefined;
        if (current && this.endsBefore(current, segment, lastFollower)) {
          await this.endSession(connection, current, tracks, targetDuration);
          if (!current.ended) {
            return;
          }
          current = undefined;
        }
        if (!current) {
          // the target duration must not change once announced, the headroom absorbs keyframe jitter
          targetDuration ||= Math.ceil(segment.duration) + 1;
          current = await this.beginSession(connection, base, tracks, segment.parts, targetDuration, reserved ?? this.context.nextSessionNumber());
          reserved = undefined;
          if (current.failed) {
            return;
          }
        }

        const active = current;
        await Promise.all(segment.parts.map(part => this.putSegment(connection, active, part)));
        if (active.failed) {
          return;
        }
        active.seconds += segment.duration;
      }

      if (current) {
        await this.endSession(connection, current, tracks, targetDuration);
      }
      debug("upload of clip %s finished", session.clipId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug("upload of clip %s failed: %s", session.clipId, message);
      if (!current?.failed) {
        this.context.reportError(current?.number ?? session.clipId, CMAFError.CONNECTION_FAILED, message);
      }
      if (current) {
        current.failed = true;
      }
    } finally {
      // a session the server saw begin is closed even after a failure, so it is not left half open on the server side
      if (current && !current.ended) {
        await this.closeTracks(connection, current, tracks, targetDuration).catch(() => undefined);
      }
      await clip.return?.(undefined).catch(() => undefined);
      connection.renew();
    }
  }

  // a session ends after five minutes; a last segment that would not fit takes the current one along, so no session
  // is left with a single segment
  private endsBefore(session: CMAFSession, segment: PreparedSegment, lastFollower?: PreparedSegment): boolean {
    if (Date.now() - session.startedAt >= MAX_SESSION_SECONDS * 1000 || session.seconds + segment.duration > MAX_SESSION_SECONDS) {
      return true;
    }
    return !!lastFollower && session.seconds + segment.duration + lastFollower.duration > MAX_SESSION_SECONDS;
  }

  private async beginSession(connection: IngestConnection, base: string, tracks: CMAFTrack[], first: CMAFTrackSegment[], targetDuration: number,
    number: bigint): Promise<CMAFSession> {
    const session: CMAFSession = {
      number,
      prefix: `${base}session_${number}/`,
      startedAt: Date.now(),
      seconds: 0,
      durations: new Map(tracks.map(track => [track.id, []])),
      opened: new Set(),
      failed: false,
      ended: false,
    };
    this.context.reportSessionStart(number);
    debug("session %s starting with tracks %s", number, tracks.map(track => track.name).join(", "));

    const multivariant = Buffer.from(buildMultivariantPlaylist(tracks, first));
    if (!(await this.putChecked(connection, session, `${session.prefix}index.m3u8`, multivariant, PLAYLIST_CONTENT_TYPE))) {
      return session;
    }
    // Matter 1.6.1 11.7.1.8.2: tracks start after the multivariant playlist, each with its initial playlist and its
    // CMAF header, and are uploaded in parallel
    await Promise.all(tracks.map(async track => {
      const playlist = Buffer.from(buildMediaPlaylist(track, targetDuration));
      if (!(await this.putChecked(connection, session, `${session.prefix}${track.name}/index.m3u8`, playlist, PLAYLIST_CONTENT_TYPE))) {
        return;
      }
      session.opened.add(track.id);
      await this.putChecked(connection, session, `${session.prefix}${track.name}/${track.name}.init`, track.init, INIT_CONTENT_TYPE);
    }));
    return session;
  }

  private async putSegment(connection: IngestConnection, session: CMAFSession, part: CMAFTrackSegment): Promise<void> {
    const durations = session.durations.get(part.track.id)!;
    const path = `${session.prefix}${part.track.name}/segment_${FIRST_SEGMENT_NUMBER + durations.length}.m4s`;
    const headers = { "x-extinf-duration": formatDuration(part.duration) };
    if (await this.putChecked(connection, session, path, part.data, SEGMENT_CONTENT_TYPE, headers)) {
      durations.push(part.duration);
    }
    for (const track of tracks) {
      const playlist = Buffer.from(buildMediaPlaylist(track, targetDuration));
      if (!(await this.putChecked(client, session, `${session.prefix}${track.name}/index.m3u8`, playlist, PLAYLIST_CONTENT_TYPE))) {
        return undefined;
      }
    }
    for (const track of tracks) {
      if (!(await this.putChecked(client, session, `${session.prefix}${track.name}/${track.name}.init`, track.init, INIT_CONTENT_TYPE))) {
        return undefined;
      }
    }
    return session;
  }

  private async endSession(connection: IngestConnection, session: CMAFSession, tracks: CMAFTrack[], targetDuration: number): Promise<void> {
    await this.closeTracks(connection, session, tracks, targetDuration);
    if (!session.failed) {
      session.ended = true;
      this.context.reportSessionStop(session.number);
      debug("session %s finished after %ds", session.number, Math.round(session.seconds));
    }
  }

  private async closeTracks(connection: IngestConnection, session: CMAFSession, tracks: CMAFTrack[], targetDuration: number): Promise<void> {
    await Promise.all(tracks.filter(track => session.opened.has(track.id)).map(async track => {
      const playlist = Buffer.from(buildMediaPlaylist(track, targetDuration, session.durations.get(track.id)));
      if (await this.putChecked(connection, session, `${session.prefix}${track.name}/index.m3u8`, playlist, PLAYLIST_CONTENT_TYPE)) {
        session.opened.delete(track.id);
      }
    }));
  }

  private async putChecked(connection: IngestConnection, session: CMAFSession, path: string, body: Buffer, contentType: string,
    headers: http2.OutgoingHttpHeaders = {}): Promise<boolean> {
    const result = await this.transfer(connection, path, body, contentType, headers);
    if (result.status >= 200 && result.status < 300) {
      return true;
    }
    if (!session.failed) {
      session.failed = true;
      const response = [result.body, result.headers].filter(Boolean).join(" ");
      const detail = `PUT ${path.slice(path.indexOf("session_"))} (${body.length} bytes) -> ${result.status} ${response}`;
      this.context.reportError(session.number, mapStatus(result.status), detail);
    }
    return false;
  }

  // a 4xx refuses the request itself, sending it unchanged again cannot succeed; transport errors and 5xx are retried
  private async transfer(connection: IngestConnection, path: string, body: Buffer, contentType: string,
    headers: http2.OutgoingHttpHeaders): Promise<PutResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await put(connection.session(), path, body, contentType, { "user-agent": this.context.userAgent, ...headers });
        if (result.status < 500 || attempt >= MAX_RETRIES) {
          return result;
        }
      } catch (error) {
        if (attempt >= MAX_RETRIES) {
          throw error;
        }
        debug("PUT %s failed, retrying: %s", path.slice(path.indexOf("session_")), error instanceof Error ? error.message : error);
      }
      connection.renew();
      await sleep(RETRY_DELAY_MS);
    }
  }
}
