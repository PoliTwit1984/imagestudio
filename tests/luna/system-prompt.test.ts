// tests/luna/system-prompt.test.ts
//
// Unit tests for buildSystemPrompt and TONE_PRESETS in lunaCompanion.ts.
//
// Validates:
//   - Tone preset keys ('flirty', 'sweet', 'filthy') expand to preset fragments
//   - Freeform persona_text is passed through verbatim
//   - Default fallback is used when persona_text is null or empty
//   - Only active memories (invalidated_at === null) are included
//   - Memory list is capped at 30 entries
//   - All three structural sections are present in every prompt

import { test, expect, describe } from "bun:test";
import {
  buildSystemPrompt,
  TONE_PRESETS,
  type Luna,
  type LunaMemory,
} from "../../src/server/lunaCompanion";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLuna(overrides: Partial<Luna> = {}): Luna {
  return {
    id: "test-luna-id",
    user_id: "test-user-id",
    name: "Luna",
    persona_text: null,
    voice_id: null,
    face_lora_url: null,
    face_ref_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMemory(overrides: Partial<LunaMemory> = {}): LunaMemory {
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    luna_id: "test-luna-id",
    type: "fact",
    body: "User prefers dark roast coffee.",
    source_msg_id: null,
    created_at: "2026-01-01T00:00:00Z",
    invalidated_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tone preset: flirty
// ---------------------------------------------------------------------------

describe("tone preset: flirty", () => {
  const luna = makeLuna({ persona_text: "flirty" });
  const prompt = buildSystemPrompt(luna, []);

  test("contains ## Persona section", () => {
    expect(prompt).toContain("## Persona");
  });

  test("persona fragment matches TONE_PRESETS.flirty", () => {
    expect(prompt).toContain(TONE_PRESETS.flirty);
  });

  test("does NOT contain the literal word 'flirty' as persona_text passthrough", () => {
    // The raw key should not appear raw — only the expanded fragment.
    // We check that the prompt body (after the heading) is the fragment, not
    // the bare key. The fragment itself does not contain a standalone "flirty"
    // on its own line.
    const lines = prompt.split("\n");
    const personaHeadingIdx = lines.findIndex((l) => l === "## Persona");
    expect(personaHeadingIdx).toBeGreaterThanOrEqual(0);
    const lineAfterHeading = lines[personaHeadingIdx + 1];
    expect(lineAfterHeading).not.toBe("flirty");
  });

  test("contains ## How I operate section", () => {
    expect(prompt).toContain("## How I operate");
  });
});

// ---------------------------------------------------------------------------
// Tone preset: sweet
// ---------------------------------------------------------------------------

describe("tone preset: sweet", () => {
  const luna = makeLuna({ persona_text: "sweet" });
  const prompt = buildSystemPrompt(luna, []);

  test("persona fragment matches TONE_PRESETS.sweet", () => {
    expect(prompt).toContain(TONE_PRESETS.sweet);
  });

  test("does not include Things I know about you when no memories", () => {
    expect(prompt).not.toContain("## Things I know about you");
  });
});

// ---------------------------------------------------------------------------
// Tone preset: filthy
// ---------------------------------------------------------------------------

describe("tone preset: filthy", () => {
  const luna = makeLuna({ persona_text: "filthy" });

  test("persona fragment matches TONE_PRESETS.filthy", () => {
    const prompt = buildSystemPrompt(luna, []);
    expect(prompt).toContain(TONE_PRESETS.filthy);
  });

  test("active memories are included in prompt", () => {
    const mem = makeMemory({ body: "User is into rough play." });
    const prompt = buildSystemPrompt(luna, [mem]);
    expect(prompt).toContain("## Things I know about you");
    expect(prompt).toContain("User is into rough play.");
  });

  test("invalidated memories are excluded", () => {
    const active = makeMemory({ body: "Active fact." });
    const invalidated = makeMemory({
      body: "Retracted fact.",
      invalidated_at: "2026-02-01T00:00:00Z",
    });
    const prompt = buildSystemPrompt(luna, [active, invalidated]);
    expect(prompt).toContain("Active fact.");
    expect(prompt).not.toContain("Retracted fact.");
  });
});

// ---------------------------------------------------------------------------
// Freeform persona_text (non-preset string)
// ---------------------------------------------------------------------------

describe("freeform persona_text", () => {
  const freeform =
    "You are a gothic librarian with a fondness for Victorian horror.";
  const luna = makeLuna({ persona_text: freeform });
  const prompt = buildSystemPrompt(luna, []);

  test("freeform text is passed through verbatim", () => {
    expect(prompt).toContain(freeform);
  });

  test("no preset fragment is injected", () => {
    for (const fragment of Object.values(TONE_PRESETS)) {
      expect(prompt).not.toContain(fragment);
    }
  });
});

// ---------------------------------------------------------------------------
// Default fallback (persona_text null / empty)
// ---------------------------------------------------------------------------

describe("default fallback", () => {
  test("null persona_text uses name-based default", () => {
    const luna = makeLuna({ name: "Sasha", persona_text: null });
    const prompt = buildSystemPrompt(luna, []);
    expect(prompt).toContain("You are Sasha, the user's personal AI companion.");
  });

  test("empty string persona_text uses name-based default", () => {
    const luna = makeLuna({ name: "Sasha", persona_text: "" });
    const prompt = buildSystemPrompt(luna, []);
    expect(prompt).toContain("You are Sasha, the user's personal AI companion.");
  });

  test("whitespace-only persona_text uses name-based default", () => {
    const luna = makeLuna({ name: "Sasha", persona_text: "   " });
    const prompt = buildSystemPrompt(luna, []);
    expect(prompt).toContain("You are Sasha, the user's personal AI companion.");
  });
});

// ---------------------------------------------------------------------------
// Memory filtering and capping
// ---------------------------------------------------------------------------

describe("memory handling", () => {
  test("only active memories (invalidated_at === null) are included", () => {
    const luna = makeLuna({ persona_text: "sweet" });
    const memories: LunaMemory[] = [
      makeMemory({ body: "Likes jazz.", invalidated_at: null }),
      makeMemory({ body: "Old address.", invalidated_at: "2026-01-15T00:00:00Z" }),
      makeMemory({ body: "Has a dog.", invalidated_at: null }),
    ];
    const prompt = buildSystemPrompt(luna, memories);
    expect(prompt).toContain("Likes jazz.");
    expect(prompt).not.toContain("Old address.");
    expect(prompt).toContain("Has a dog.");
  });

  test("memory list is capped at 30 entries", () => {
    const luna = makeLuna();
    const memories = Array.from({ length: 40 }, (_, i) =>
      makeMemory({ body: `Memory number ${i + 1}.` })
    );
    const prompt = buildSystemPrompt(luna, memories);
    // Memories 1-30 should appear; 31-40 should not.
    expect(prompt).toContain("Memory number 30.");
    expect(prompt).not.toContain("Memory number 31.");
  });

  test("all three sections present when memories exist", () => {
    const luna = makeLuna({ persona_text: "flirty" });
    const mem = makeMemory({ body: "User is a night owl." });
    const prompt = buildSystemPrompt(luna, [mem]);
    expect(prompt).toContain("## Persona");
    expect(prompt).toContain("## Things I know about you");
    expect(prompt).toContain("## How I operate");
  });
});

// ---------------------------------------------------------------------------
// TONE_PRESETS export sanity
// ---------------------------------------------------------------------------

describe("TONE_PRESETS export", () => {
  test("exports all six expected keys", () => {
    const keys = Object.keys(TONE_PRESETS).sort();
    expect(keys).toEqual(["dom", "filthy", "flirty", "snarky", "sub", "sweet"]);
  });

  test("every preset value is a non-empty string", () => {
    for (const [key, value] of Object.entries(TONE_PRESETS)) {
      expect(typeof value).toBe("string");
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
