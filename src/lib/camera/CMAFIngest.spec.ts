import { EventEmitter } from "events";
import http2 from "http2";

import { initSegment, mediaSegment } from "../../test-utils/fmp4";
import { buildMediaPlaylist, buildMultivariantPlaylist, CMAFIngest, formatDuration, mapStatus } from "./CMAFIngest";
import { splitInitSegment } from "./CMAFTracks";
import { BufferUploadCommandType, CMAFError } from "./SecureVideoTypes";

import type { CMAFIngestContext } from "./CMAFIngest";
import type { CMAFRecordingDelegate, CMAFSegment, SecureVideoIngestCredentials } from "../controller/SecureVideoController";

const VIDEO = { id: 1, handler: "vide" as const, timescale: 90000 };
const AUDIO = { id: 2, handler: "soun" as const, timescale: 32000, defaultSampleDuration: 1024 };
const SENSOR = "6d3b7b46-8a7d-4a8f-9c5a-1f7e0f0c0b1a";
const MEDIA = { codecs: "hvc1.1.6.L120.B0", width: 1920, height: 1080, bitrate: 1700000 };
const BASE = "/v1/token/";

interface Request {
  path: string;
  contentType: string;
  extinf?: string;
  body: string;
}

function fragment(seconds: number): Buffer {
  return mediaSegment(1, [
    { trackId: 1, durations: [seconds * 90000], samples: [Buffer.alloc(100, 1)] },
    { trackId: 2, durations: [1024], samples: [Buffer.alloc(20, 2)] },
  ]);
}

function fakeClient(requests: Request[], status: (path: string) => number, closed: () => void) {
  return {
    on: jest.fn(),
    close: closed,
    request: (headers: http2.OutgoingHttpHeaders) => {
      const stream = new EventEmitter() as EventEmitter & { end(body: Buffer): void };
      stream.end = body => {
        const path = String(headers[":path"]);
        requests.push({
          path: path.slice(BASE.length),
          contentType: String(headers["content-type"]),
          extinf: headers["x-extinf-duration"] as string | undefined,
          body: body.toString("latin1"),
        });
        setImmediate(() => {
          stream.emit("response", { ":status": status(path) });
          stream.emit("end");
        });
      };
      return stream;
    },
  } as unknown as http2.ClientHttp2Session;
}

function setup(segments: CMAFSegment[], status: (path: string) => number = () => 201) {
  const requests: Request[] = [];
  const events: string[] = [];
  let sessionNumber = 0n;

  // the upload closes the client as its very last step
  let closed!: () => void;
  const done = new Promise<void>(resolve => {
    closed = resolve;
  });
  jest.spyOn(http2, "connect").mockReturnValue(fakeClient(requests, status, closed));

  const delegate: CMAFRecordingDelegate = {
    async *streamClip() {
      yield* segments;
    },
  };
  const context: CMAFIngestContext = {
    sensorUUID: SENSOR,
    media: MEDIA,
    credentials: () => ({
      publishingPoint: { url: `https://ingest.example.com${BASE}`, serverCACertificates: [] },
      privateKey: "key",
      clientCertificate: Buffer.from("cert"),
      keys: [],
    }) as unknown as SecureVideoIngestCredentials,
    nextSessionNumber: () => ++sessionNumber,
    reportSessionStart: number => events.push(`start ${number}`),
    reportSessionStop: number => events.push(`stop ${number}`),
    reportError: (number, error) => events.push(`error ${number} ${error}`),
  };

  const ingest = new CMAFIngest(delegate, context);
  ingest.handleUploadCommand({ sessionId: 99n, command: BufferUploadCommandType.START_AND_STOP });
  return { requests, events, done };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("CMAFIngest", () => {
  test("builds the multivariant playlist with audio as a rendition", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const lines = buildMultivariantPlaylist(SENSOR, MEDIA, tracks).split("\n");

    expect(lines[0]).toBe("#EXTM3U");
    expect(lines).toContain(`#EXT-X-SESSION-DATA:DATA-ID="com.apple.homekit.sensor-id",VALUE="${SENSOR}"`);
    expect(lines).toContain("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"audio\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio/index.m3u8\"");
    const variant = "#EXT-X-STREAM-INF:BANDWIDTH=1700000,CODECS=\"hvc1.1.6.L120.B0,mp4a.40.2\",RESOLUTION=1920x1080,AUDIO=\"audio\"";
    expect(lines[lines.indexOf(variant) + 1]).toBe("video/index.m3u8");
    expect(lines.filter(line => line.startsWith("#EXT-X-MEDIA") || line.startsWith("#EXT-X-STREAM-INF"))).toHaveLength(2);
    expect(lines.some(line => line.includes("KEY"))).toBe(false);
  });

  test("builds the initial and the final media playlist", () => {
    const [video] = splitInitSegment(initSegment([VIDEO]));

    const initial = buildMediaPlaylist(video, 5).split("\n");
    expect(initial).toContain("#EXT-X-TARGETDURATION:5");
    expect(initial).toContain("#EXT-X-MEDIA-SEQUENCE:1001");
    expect(initial).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(initial).toContain("#EXT-X-MAP:URI=\"video.init\"");
    expect(initial.some(line => line.startsWith("#EXTINF") || line.endsWith(".m4s"))).toBe(false);
    expect(initial).not.toContain("#EXT-X-ENDLIST");

    const final = buildMediaPlaylist(video, 5, [4, 6.4]).split("\n");
    expect(final).toContain("#EXT-X-TARGETDURATION:6");
    expect(final.slice(final.indexOf("#EXTINF:4.00000,"))).toEqual([
      "#EXTINF:4.00000,",
      "segment_1001.m4s",
      "#EXTINF:6.40000,",
      "segment_1002.m4s",
      "#EXT-X-ENDLIST",
      "",
    ]);
  });

  test("formats durations with five decimals", () => {
    expect(formatDuration(4)).toBe("4.00000");
    expect(formatDuration(4.123456)).toBe("4.12346");
  });

  test("uploads a clip in the order of the Matter HLS ingest", async () => {
    const { requests, events, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(4) },
      { type: "media", data: fragment(4), last: true },
    ]);
    await done;

    expect(requests.map(({ path, contentType, extinf }) => `${path} ${contentType}${extinf ? ` ${extinf}` : ""}`)).toEqual([
      "session_1/index.m3u8 application/vnd.apple.mpegurl",
      "session_1/video/index.m3u8 application/vnd.apple.mpegurl",
      "session_1/audio/index.m3u8 application/vnd.apple.mpegurl",
      "session_1/video/video.init video/mp4",
      "session_1/audio/audio.init video/mp4",
      "session_1/video/segment_1001.m4s video/iso.segment 4.00000",
      "session_1/audio/segment_1001.m4s video/iso.segment 0.03200",
      "session_1/video/segment_1002.m4s video/iso.segment 4.00000",
      "session_1/audio/segment_1002.m4s video/iso.segment 0.03200",
      "session_1/video/index.m3u8 application/vnd.apple.mpegurl",
      "session_1/audio/index.m3u8 application/vnd.apple.mpegurl",
    ]);
    expect(requests[1].body).not.toContain("#EXT-X-ENDLIST");
    expect(requests[9].body).toContain("segment_1002.m4s\n#EXT-X-ENDLIST");
    expect(events).toEqual(["start 1", "stop 1"]);
  });

  test("continues a recording longer than five minutes in the next session", async () => {
    const { requests, events, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(100), last: true },
    ]);
    await done;

    const paths = requests.map(request => request.path);
    expect(paths.filter(path => path.startsWith("session_1/video/segment_"))).toHaveLength(3);
    expect(paths.slice(paths.indexOf("session_2/index.m3u8"))).toEqual([
      "session_2/index.m3u8",
      "session_2/video/index.m3u8",
      "session_2/audio/index.m3u8",
      "session_2/video/video.init",
      "session_2/audio/audio.init",
      "session_2/video/segment_1001.m4s",
      "session_2/audio/segment_1001.m4s",
      "session_2/video/index.m3u8",
      "session_2/audio/index.m3u8",
    ]);
    expect(paths.indexOf("session_2/index.m3u8")).toBeGreaterThan(paths.lastIndexOf("session_1/audio/index.m3u8"));
    expect(events).toEqual(["start 1", "stop 1", "start 2", "stop 2"]);
  });

  test("stops at the first rejected request", async () => {
    const { requests, events, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(4), last: true },
    ], path => (path.endsWith("video/index.m3u8") ? 400 : 201));
    await done;

    expect(requests.map(request => request.path)).toEqual(["session_1/index.m3u8", "session_1/video/index.m3u8"]);
    expect(events).toEqual(["start 1", `error 1 ${CMAFError.HTTP_BAD_REQUEST}`]);
  });

  test("maps http statuses to cmaf errors", () => {
    expect(mapStatus(400)).toBe(CMAFError.HTTP_BAD_REQUEST);
    expect(mapStatus(401)).toBe(CMAFError.HTTP_INVALID_TOKEN);
    expect(mapStatus(403)).toBe(CMAFError.HTTP_INVALID_TOKEN);
    expect(mapStatus(404)).toBe(CMAFError.HTTP_NOT_FOUND);
    expect(mapStatus(412)).toBe(CMAFError.HTTP_INIT_MISSING);
    expect(mapStatus(415)).toBe(CMAFError.HTTP_UNSUPPORTED_MEDIA_TYPE);
    expect(mapStatus(503)).toBe(CMAFError.HTTP_SERVICE_UNAVAILABLE);
    expect(mapStatus(500)).toBe(CMAFError.HTTP_INTERNAL_SERVER_ERROR);
    expect(mapStatus(418)).toBe(CMAFError.UNKNOWN);
  });
});
