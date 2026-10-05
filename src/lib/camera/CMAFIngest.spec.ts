import { EventEmitter } from "events";
import http2 from "http2";

import { initSegment, mediaSegment } from "../../test-utils/fmp4";
import { buildMediaPlaylist, buildMultivariantPlaylist, CMAFIngest, formatDuration, mapStatus } from "./CMAFIngest";
import { splitInitSegment, splitMediaSegment } from "./CMAFTracks";
import { BufferUploadCommandType, CMAFError } from "./SecureVideoTypes";

import type { CMAFIngestContext } from "./CMAFIngest";
import type { CMAFRecordingDelegate, CMAFSegment, SecureVideoIngestCredentials } from "../controller/SecureVideoController";

const VIDEO = { id: 1, handler: "vide" as const, timescale: 90000 };
const AUDIO = { id: 2, handler: "soun" as const, timescale: 32000, defaultSampleDuration: 1024 };
const BASE = "/v1/token/";

interface Request {
  path: string;
  contentType: string;
  userAgent?: string;
  extinf?: string;
  body: string;
}

function fragment(seconds: number, nonSyncStart = false): Buffer {
  return mediaSegment(1, [
    { trackId: 1, durations: [seconds * 45000, seconds * 45000], samples: [Buffer.alloc(100, 1), Buffer.alloc(100, 1)], nonSyncStart },
    { trackId: 2, durations: [1024], samples: [Buffer.alloc(20, 2)] },
  ]);
}

function fakeClient(requests: Request[], status: (path: string, attempt: number) => number, attempts: Map<string, number>) {
  return {
    on: jest.fn(),
    closed: false,
    destroyed: false,
    close: jest.fn(),
    request: (headers: http2.OutgoingHttpHeaders) => {
      const stream = new EventEmitter() as EventEmitter & { end(body: Buffer): void };
      stream.end = body => {
        const path = String(headers[":path"]).slice(BASE.length);
        const attempt = attempts.get(path) ?? 0;
        attempts.set(path, attempt + 1);
        requests.push({
          path,
          contentType: String(headers["content-type"]),
          userAgent: headers["user-agent"] as string | undefined,
          extinf: headers["x-extinf-duration"] as string | undefined,
          body: body.toString("latin1"),
        });
        setImmediate(() => {
          stream.emit("response", { ":status": status(path, attempt), "x-apple-request-uuid": "4f1c" });
          stream.emit("end");
        });
      };
      return stream;
    },
  } as unknown as http2.ClientHttp2Session;
}

function setup(segments: CMAFSegment[], status: (path: string, attempt: number) => number = () => 201) {
  const requests: Request[] = [];
  const events: string[] = [];
  const errors: string[] = [];
  const attempts = new Map<string, number>();
  let sessionNumber = 0n;
  const connect = jest.spyOn(http2, "connect").mockImplementation(() => fakeClient(requests, status, attempts));

  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => {
    resolveDone = resolve;
  });
  const delegate: CMAFRecordingDelegate = {
    async *streamClip() {
      try {
        yield* segments;
      } finally {
        // the generator is closed in the upload's cleanup, after the last request; give the event loop a few turns
        setTimeout(resolveDone, 20);
      }
    },
  };
  const context: CMAFIngestContext = {
    userAgent: "test-agent/1.0",
    credentials: () => ({
      publishingPoint: { url: `https://ingest.example.com${BASE}`, serverCACertificates: [] },
      privateKey: "key",
      clientCertificate: Buffer.from("cert"),
      keys: [],
    }) as unknown as SecureVideoIngestCredentials,
    nextSessionNumber: () => ++sessionNumber,
    reportSessionStart: number => events.push(`start ${number}`),
    reportSessionStop: number => events.push(`stop ${number}`),
    reportError: (number, error, detail) => {
      events.push(`error ${number} ${error}`);
      errors.push(detail ?? "");
    },
  };

  const ingest = new CMAFIngest(delegate, context);
  const clipId = ingest.handleUploadCommand({ sessionId: 99n, command: BufferUploadCommandType.START_AND_STOP });
  return { requests, events, errors, clipId, done, connects: () => connect.mock.calls.length };
}

const videoSegments = (requests: Request[], session: number) =>
  requests.filter(request => request.path.startsWith(`session_${session}/video/segment_`)).length;

afterEach(() => {
  jest.restoreAllMocks();
});

describe("CMAFIngest", () => {
  test("builds the multivariant playlist from the tracks and the first segment", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const first = splitMediaSegment(fragment(4), tracks);
    const lines = buildMultivariantPlaylist(tracks, first).split("\n");
    const bandwidth = Math.ceil(first.reduce((sum, part) => sum + part.data.length * 8 / part.duration, 0));

    expect(lines[0]).toBe("#EXTM3U");
    expect(lines).toContain("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"audio\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"1\",URI=\"audio/index.m3u8\"");
    const variant = `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="hvc1.1.6.L93.B0,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=0.500,AUDIO="audio"`;
    expect(lines[lines.indexOf(variant) + 1]).toBe("video/index.m3u8");
    expect(lines.filter(line => line.startsWith("#EXT-X-MEDIA") || line.startsWith("#EXT-X-STREAM-INF"))).toHaveLength(2);
    expect(lines.some(line => line.includes("SESSION") || line.includes("KEY"))).toBe(false);
  });

  test("builds the initial and the final media playlist", () => {
    const [video] = splitInitSegment(initSegment([VIDEO]));

    expect(buildMediaPlaylist(video, 5).split("\n")).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:5",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-MAP:URI=\"video.init\"",
      "",
    ]);

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
    const { requests, events, clipId, done } = setup([
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
    expect(requests.every(request => request.userAgent === "test-agent/1.0")).toBe(true);
    expect(requests[1].body).not.toContain("#EXT-X-ENDLIST");
    expect(requests[9].body).toContain("segment_1002.m4s\n#EXT-X-ENDLIST");
    expect(events).toEqual(["start 1", "stop 1"]);
    // the hub links the upload to its clip through the first CMAF session number
    expect(clipId).toBe(1n);
  });

  test("continues a recording longer than five minutes in the next session", async () => {
    const { requests, events, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(90) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(100), last: true },
    ]);
    await done;

    expect(videoSegments(requests, 1)).toBe(3);
    expect(videoSegments(requests, 2)).toBe(2);
    const paths = requests.map(request => request.path);
    expect(paths.indexOf("session_2/index.m3u8")).toBeGreaterThan(paths.lastIndexOf("session_1/audio/index.m3u8"));
    expect(events).toEqual(["start 1", "stop 1", "start 2", "stop 2"]);
  });

  test("never leaves a session with a single segment", async () => {
    const { requests, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(100) },
      { type: "media", data: fragment(50) },
      { type: "media", data: fragment(100), last: true },
    ]);
    await done;

    // 100 + 100 + 50 fit, but the last 100 would then form a session of its own
    expect(videoSegments(requests, 1)).toBe(2);
    expect(videoSegments(requests, 2)).toBe(2);
  });

  test("lets a fragment without a sync sample continue the segment before it", async () => {
    const { requests, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(2) },
      { type: "media", data: fragment(0.5, true) },
      { type: "media", data: fragment(2), last: true },
    ]);
    await done;

    const video = requests.filter(request => request.path.startsWith("session_1/video/segment_"));
    expect(video.map(request => `${request.path.split("/").pop()} ${request.extinf}`)).toEqual(["segment_1001.m4s 2.50000", "segment_1002.m4s 2.00000"]);
    expect(video[0].body.split("moof").length - 1).toBe(2);
  });

  test("sends a request again on a new connection after a server error", async () => {
    const { requests, events, connects, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(4), last: true },
    ], (path, attempt) => (path === "session_1/index.m3u8" && attempt === 0 ? 503 : 201));
    await done;

    expect(requests.filter(request => request.path === "session_1/index.m3u8")).toHaveLength(2);
    expect(connects()).toBe(2);
    expect(events).toEqual(["start 1", "stop 1"]);
  });

  test("reports the first refusal once and closes the opened tracks", async () => {
    const { requests, events, errors, done } = setup([
      { type: "init", data: initSegment([VIDEO, AUDIO]) },
      { type: "media", data: fragment(4) },
      { type: "media", data: fragment(4), last: true },
    ], path => (path.endsWith("segment_1001.m4s") ? 400 : 201));
    await done;

    expect(events).toEqual(["start 1", `error 1 ${CMAFError.HTTP_BAD_REQUEST}`]);
    expect(errors[0]).toMatch(/^PUT session_1\/(video|audio)\/segment_1001\.m4s \(\d+ bytes\) -> 400 x-apple-request-uuid=4f1c$/);
    // a 4xx is not sent again
    expect(requests.filter(request => request.path === "session_1/video/segment_1001.m4s")).toHaveLength(1);
    // the server saw the session begin, so its tracks are closed even though the upload failed
    expect(requests.slice(-2).map(request => request.path)).toEqual(["session_1/video/index.m3u8", "session_1/audio/index.m3u8"]);
    expect(requests.at(-1)!.body).toContain("#EXT-X-ENDLIST");
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
