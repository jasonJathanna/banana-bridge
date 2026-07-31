import assert from "node:assert/strict";
import test from "node:test";
import { RATE_LIMIT_TEXT, isRateLimitStatus } from "../src/providers/shared.js";

test("recognizes the ways Google says you are out of quota", () => {
  const shouldMatch = [
    "You've reached your limit for image generation. Try again later.",
    "You have reached your daily limit for this model.",
    "You've hit your limit on image generation for today",
    "Image generation is no longer available today",
    "You've exceeded your quota. Please try again tomorrow.",
    "Try again in a few hours",
    "You're out of generations for now",
    "You are out of credits",
    "rate limit exceeded",
    "rate-limited",
  ];
  for (const text of shouldMatch) {
    assert.ok(RATE_LIMIT_TEXT.test(text), `should match: ${text}`);
  }
});

test("does not mistake a content refusal or ordinary prose for a quota problem", () => {
  // These must stay safety_blocked or a normal response: reporting them as
  // quota_exhausted would tell the caller to wait a day over a fixable prompt.
  const shouldNotMatch = [
    "I can't create that image because it may depict a real person.",
    "Sorry, I can't help with that request.",
    "Here is your image of a banana.",
    "Gemini said",
    "Creating your image",
    "This image has a wide dynamic range and a soft limit of detail in the shadows",
    "I've limited the palette to three colours as you asked",
    "The subject is a limited-edition sports car",
  ];
  for (const text of shouldNotMatch) {
    assert.ok(!RATE_LIMIT_TEXT.test(text), `should NOT match: ${text}`);
  }
});

test("only 429 counts as a rate-limit status", () => {
  assert.equal(isRateLimitStatus(429), true);
  for (const status of [200, 204, 302, 400, 401, 403, 404, 500, 503]) {
    assert.equal(isRateLimitStatus(status), false, `status ${status}`);
  }
});

test("the pattern is reusable across calls (no lastIndex surprise)", () => {
  // A global-flagged regex would carry lastIndex between .test() calls and start
  // returning false at random, which is exactly the kind of intermittent bug that
  // would make quota detection look flaky rather than broken.
  assert.equal(RATE_LIMIT_TEXT.global, false);
  const text = "You've reached your limit for today";
  for (let i = 0; i < 5; i++) assert.ok(RATE_LIMIT_TEXT.test(text), `call ${i}`);
});
