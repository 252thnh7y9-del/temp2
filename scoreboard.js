// Read the score and game clock from a photo of a scoreboard.
//
// Usage:  node scoreboard.js <photo.jpg>
// Needs:  ANTHROPIC_API_KEY in the environment.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MEDIA_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// The model must reply with exactly this shape.
const SCHEMA = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        name: { type: "string" },
        score: { type: "integer" },
      },
      required: ["name", "score"],
      additionalProperties: false,
    },
    away: {
      type: "object",
      properties: {
        name: { type: "string" },
        score: { type: "integer" },
      },
      required: ["name", "score"],
      additionalProperties: false,
    },
    clock: {
      type: "string",
      description: "Game clock exactly as shown, e.g. '2:34' or '0:45.3'",
    },
    period: { type: ["integer", "null"] },
  },
  required: ["home", "away", "clock", "period"],
  additionalProperties: false,
};

const PROMPT = `This is a photo of a sports scoreboard. Read it and report:
- each team's name and score (the team on the left is "home", the team on the right is "away")
- the game clock, exactly as displayed
- the period/quarter, or null if none is shown
Ignore team fouls, timeouts, logos and anything that is not the score, clock or period.`;

const client = new Anthropic();

/**
 * @param {Buffer} imageBytes  the photo
 * @param {string} mediaType   e.g. "image/jpeg"
 * @returns {Promise<{home:{name:string,score:number}, away:{name:string,score:number}, clock:string, period:number|null, seconds:number|null}>}
 */
export async function readScoreboard(imageBytes, mediaType = "image/jpeg") {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    // If the request is ever declined, the API retries it on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBytes.toString("base64"),
            },
          },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Request declined: ${response.stop_details?.explanation ?? "no reason given"}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Response was cut off before the JSON was complete");
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No text in response");
  const result = JSON.parse(text);

  return { ...result, seconds: clockToSeconds(result.clock) };
}

// "2:34" -> 154, "0:45.3" -> 45.3, "45.3" -> 45.3. Returns null if unreadable.
export function clockToSeconds(clock) {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(clock ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2]);
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scoreboard.js <photo>");
    process.exit(1);
  }
  const mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!mediaType) {
    console.error(`Unsupported image type: ${file}`);
    process.exit(1);
  }
  const result = await readScoreboard(fs.readFileSync(file), mediaType);
  console.log(JSON.stringify(result, null, 2));
}
