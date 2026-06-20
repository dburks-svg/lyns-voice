import { describe, it, expect } from 'vitest';

import {
  SERVER_MARKER_BEGIN,
  SERVER_MARKER_END,
  buildServerBlock,
  isServerPatched,
  looksLikeVoiceHooksServer,
  patchServer,
  stripLegacyUnmarkedRoute,
  unpatchServer,
} from '../scripts/server-patch-core.mjs';

/** A minimal stand-in for the mcp-voice-hooks unified-server.js shape. */
const SERVER_FIXTURE = [
  'import express from "express";',
  'var app = express();',
  'app.use(express.json());',
  'app.post("/api/speak", (req, res) => res.end());',
  'app.listen(5111, () => {',
  '  console.log("up");',
  '});',
  '',
].join('\n');

/** The earlier hand-applied (marker-less) route we migrate away from. */
const LEGACY_ROUTE = [
  'app.post("/api/tts-wav", async (req, res) => {',
  '  const { text } = req.body;',
  '  res.send(Buffer.from(text));',
  '});',
].join('\n');

describe('buildServerBlock', () => {
  it('wraps the tts-wav route between the markers', () => {
    const block = buildServerBlock();
    expect(block.startsWith(SERVER_MARKER_BEGIN)).toBe(true);
    expect(block.endsWith(SERVER_MARKER_END)).toBe(true);
    expect(block).toContain('app.post("/api/tts-wav"');
    expect(block).toContain('audio/wav');
  });

  it('is self-contained: no reliance on outer-scope symbols a build could rename', () => {
    const block = buildServerBlock();
    // every dependency is dynamically imported inside the handler
    expect(block).toContain('await import("util")');
    expect(block).toContain('await import("crypto")');
    expect(block).toContain('await import("child_process")');
    // and it never calls debugLog (which a future build may not expose)
    expect(block).not.toContain('debugLog');
  });
});

describe('patchServer', () => {
  it('inserts the block immediately before app.listen(', () => {
    const out = patchServer(SERVER_FIXTURE);
    expect(isServerPatched(out)).toBe(true);
    expect(out.indexOf(SERVER_MARKER_BEGIN)).toBeLessThan(out.indexOf('app.listen('));
  });

  it('is idempotent: patching twice yields identical output', () => {
    const once = patchServer(SERVER_FIXTURE);
    const twice = patchServer(once);
    expect(twice).toBe(once);
    expect(twice.match(/\/api\/tts-wav/g)).toHaveLength(1);
  });

  it('migrates a legacy unmarked route to a single marked block', () => {
    const manual = SERVER_FIXTURE.replace('app.listen(', `${LEGACY_ROUTE}\napp.listen(`);
    expect(manual.match(/\/api\/tts-wav/g)).toHaveLength(1);
    const out = patchServer(manual);
    // exactly one route, now marker-delimited
    expect(out.match(/app\.post\("\/api\/tts-wav"/g)).toHaveLength(1);
    expect(isServerPatched(out)).toBe(true);
  });

  it('throws when there is no app.listen( to anchor to', () => {
    expect(() => patchServer('var app = express();')).toThrow(/app\.listen/);
  });
});

describe('unpatchServer', () => {
  it('round-trips: patch then unpatch restores the original exactly', () => {
    const patched = patchServer(SERVER_FIXTURE);
    expect(patched).not.toBe(SERVER_FIXTURE);
    expect(unpatchServer(patched)).toBe(SERVER_FIXTURE);
  });

  it('is a no-op when no marked block is present', () => {
    expect(unpatchServer(SERVER_FIXTURE)).toBe(SERVER_FIXTURE);
  });
});

describe('stripLegacyUnmarkedRoute', () => {
  it('removes a hand-applied tts-wav route', () => {
    const manual = SERVER_FIXTURE.replace('app.listen(', `${LEGACY_ROUTE}\napp.listen(`);
    const out = stripLegacyUnmarkedRoute(manual);
    expect(out).not.toContain('/api/tts-wav');
    expect(out).toContain('app.listen(');
  });
});

describe('looksLikeVoiceHooksServer', () => {
  it('accepts the server fixture', () => {
    expect(looksLikeVoiceHooksServer(SERVER_FIXTURE)).toBe(true);
  });

  it('rejects an unrelated file', () => {
    expect(looksLikeVoiceHooksServer('console.log("hi");')).toBe(false);
  });
});
