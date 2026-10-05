import createDebug from "debug";
import http2 from "http2";

import { splitInitSegment, splitMediaSegment } from "./CMAFTracks";
import { BufferUploadCommandType, CMAFError } from "./SecureVideoTypes";

import type { CMAFTrack, CMAFTrackSegment } from "./CMAFTracks";
import type { BufferUploadCommandRequest } from "./SecureVideoTypes";
import type { CMAFRecordingDelegate, SecureVideoIngestCredentials } from "../controller/SecureVideoController";

const debug = createDebug("HAP-NodeJS:SecureVideo:Ingest");

const FIRST_SEGMENT_NUMBER = 1001;
const DEFAULT_SEGMENT_DURATION_SECONDS = 2;
// Matter 1.6.1 Push AV Stream Transport: a session lasts at most five minutes, a longer recording continues in the next
const MAX_SESSION_SECONDS = 300;
const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";
const INIT_CONTENT_TYPE = "video/mp4";
const SEGMENT_CONTENT_TYPE = "video/iso.segment";

/**
 * Media description the controller advertises in the HLS multivariant playlist.
 *
 * @group Camera Secure Video
 */
export interface CMAFMediaDescription {
  /** HLS codecs attribute of the video, e.g. `hvc1.1.6.L120.B0` */
  codecs: string;
  width: number;
  height: number;
  /** bits per second */
  bitrate: number;
}

/**
 * Everything the ingest needs from the controller: the negotiated credentials, the advertised media description, the
 * persisted session number and the event reporters. Keeps the credential and event handling internal to the controller.
 *
 * @group Camera Secure Video
 */
export interface CMAFIngestContext {
  sensorUUID: string;
  media: CMAFMediaDescription;
  credentials(): SecureVideoIngestCredentials;
  /** the number of the next CMAF session: starts at 1 after pairing, persisted, never reused */
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
  /** the hub sent stop, the upload ends with the next fragment */
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
}

interface PutResult {
  status: number;
  /** first bytes of the response body, the ingest edge explains rejections there */
  body: string;
  /** response headers as name=value pairs, they carry the request id Apple asks for */
  headers: string;
}

function put(client: http2.ClientHttp2Session, path: string, body: Buffer, contentType: string, headers: http2.OutgoingHttpHeaders = {}): Promise<PutResult> {
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

/**
 * Formats a segment duration for the `#EXTINF` tag and the `X-EXTINF-duration` header.
 *
 * @group Camera Secure Video
 */
export function formatDuration(seconds: number): string {
  return seconds.toFixed(5);
}

/**
 * Builds the HLS multivariant playlist of a CMAF session: one variant for the video track, audio tracks as renditions.
 *
 * @group Camera Secure Video
 */
export function buildMultivariantPlaylist(sensorUUID: string, media: CMAFMediaDescription, tracks: CMAFTrack[]): string {
  const video = tracks.find(track => track.kind === "video");
  if (!video) {
    throw new Error("a CMAF session needs a video track");
  }
  const audio = tracks.filter(track => track.kind === "audio");
  const codecs = [media.codecs, ...audio.slice(0, 1).map(track => track.codecs ?? "mp4a.40.2")].join(",");

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-SESSION-DATA:DATA-ID="com.apple.homekit.sensor-id",VALUE="${sensorUUID}"`,
  ];
  audio.forEach((track, index) => {
    const defaultTrack = index === 0 ? "YES" : "NO";
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${track.name}",DEFAULT=${defaultTrack},AUTOSELECT=YES,URI="${track.name}/index.m3u8"`);
  });
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${media.bitrate},CODECS="${codecs}",RESOLUTION=${media.width}x${media.height}${audio.length ? ",AUDIO=\"audio\"" : ""}`,
    `${video.name}/index.m3u8`,
    "",
  );
  return lines.join("\n");
}

/**
 * Builds the HLS media playlist of a track. Without durations it is the initial playlist that opens the track, with
 * them the final one that lists every uploaded segment and closes it.
 *
 * @group Camera Secure Video
 */
export function buildMediaPlaylist(track: CMAFTrack, targetDuration: number, durations?: number[]): string {
  const target = Math.max(targetDuration, ...(durations ?? []).map(Math.round));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${FIRST_SEGMENT_NUMBER}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${track.name}.init"`,
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
      this.context.reportError(0n, CMAFError.INVALID_STATE);
      return;
    }

    const url = new URL(publishingPoint.url);
    const base = trailingSlash(url.pathname);
    const client = http2.connect(url.origin, {
      key: privateKey,
      cert: [toPem(clientCertificate), ...(ca ? [toPem(ca)] : [])].join(""),
      ca: publishingPoint.serverCACertificates.map(toPem),
    });
    client.on("error", error => debug("http2 session error: %s", error.message));

    const clip = this.delegate.streamClip({ command: request, signal: session.abort.signal });
    let current: CMAFSession | undefined;
    try {
      const first = await clip.next();
      if (first.done || first.value.type !== "init") {
        throw new Error("delegate did not yield an init segment first");
      }
      const tracks = splitInitSegment(first.value.data);
      if (!tracks.some(track => track.kind === "video")) {
        throw new Error("init segment without a video track");
      }
      const media = first.value.media ?? this.context.media;
      let targetDuration: number | undefined;
      let reservedNumber: bigint | undefined = session.clipId;

      for await (const segment of clip) {
        if (segment.type !== "media") {
          continue;
        }
        const fallback = segment.duration ?? DEFAULT_SEGMENT_DURATION_SECONDS;
        const parts = splitMediaSegment(segment.data, tracks).map(part => (part.duration > 0 ? part : { ...part, duration: fallback }));
        const duration = parts.reduce((longest, part) => Math.max(longest, part.duration), 0);
        // the target duration must not change once announced, the headroom absorbs keyframe jitter
        targetDuration ??= Math.ceil(duration) + 1;

        if (current && (current.seconds + duration > MAX_SESSION_SECONDS || Date.now() - current.startedAt >= MAX_SESSION_SECONDS * 1000)) {
          const ended = await this.endSession(client, current, tracks, targetDuration);
          current = undefined;
          if (!ended) {
            return;
          }
        }
        if (!current) {
          current = await this.beginSession(client, base, tracks, media, targetDuration, reservedNumber ?? this.context.nextSessionNumber());
          reservedNumber = undefined;
          if (!current) {
            return;
          }
        }

        for (const part of parts) {
          if (!(await this.putSegment(client, current, part))) {
            return;
          }
        }
        current.seconds += duration;
        if (session.stopRequested || segment.last) {
          break;
        }
      }

      if (current) {
        const ended = await this.endSession(client, current, tracks, targetDuration!);
        current = undefined;
        if (!ended) {
          return;
        }
      }
      debug("upload of clip %s finished", session.clipId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug("upload of clip %s failed: %s", session.clipId, message);
      this.context.reportError(current?.number ?? 0n, CMAFError.CONNECTION_FAILED, message);
    } finally {
      await clip.return?.(undefined).catch(() => undefined);
      client.close();
    }
  }

  private async beginSession(client: http2.ClientHttp2Session, base: string, tracks: CMAFTrack[], media: CMAFMediaDescription,
    targetDuration: number, number: bigint): Promise<CMAFSession | undefined> {
    const session: CMAFSession = {
      number,
      prefix: `${base}session_${number}/`,
      startedAt: Date.now(),
      seconds: 0,
      durations: new Map(tracks.map(track => [track.id, []])),
    };
    this.context.reportSessionStart(number);
    debug("session %s starting with tracks %s", number, tracks.map(track => track.name).join(", "));

    const multivariant = Buffer.from(buildMultivariantPlaylist(this.context.sensorUUID, media, tracks));
    if (!(await this.putChecked(client, session, `${session.prefix}index.m3u8`, multivariant, PLAYLIST_CONTENT_TYPE))) {
      return undefined;
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

  private async putSegment(client: http2.ClientHttp2Session, session: CMAFSession, part: CMAFTrackSegment): Promise<boolean> {
    const durations = session.durations.get(part.track.id)!;
    const path = `${session.prefix}${part.track.name}/segment_${FIRST_SEGMENT_NUMBER + durations.length}.m4s`;
    const uploaded = await this.putChecked(client, session, path, part.data, SEGMENT_CONTENT_TYPE, { "x-extinf-duration": formatDuration(part.duration) });
    if (uploaded) {
      durations.push(part.duration);
    }
    return uploaded;
  }

  private async endSession(client: http2.ClientHttp2Session, session: CMAFSession, tracks: CMAFTrack[], targetDuration: number): Promise<boolean> {
    for (const track of tracks) {
      const playlist = Buffer.from(buildMediaPlaylist(track, targetDuration, session.durations.get(track.id)));
      if (!(await this.putChecked(client, session, `${session.prefix}${track.name}/index.m3u8`, playlist, PLAYLIST_CONTENT_TYPE))) {
        return false;
      }
    }
    this.context.reportSessionStop(session.number);
    debug("session %s finished after %ds", session.number, Math.round(session.seconds));
    return true;
  }

  private async putChecked(client: http2.ClientHttp2Session, session: CMAFSession, path: string, body: Buffer, contentType: string,
    headers?: http2.OutgoingHttpHeaders): Promise<boolean> {
    const result = await put(client, path, body, contentType, headers);
    if (result.status >= 200 && result.status < 300) {
      return true;
    }
    const response = [result.body, result.headers].filter(Boolean).join(" ");
    const detail = `PUT ${path.slice(path.indexOf("session_"))} (${body.length} bytes) -> ${result.status} ${response}`;
    this.context.reportError(session.number, mapStatus(result.status), detail);
    return false;
  }
}
