import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.ts";

test("protocol version is a positive integer", () => {
  expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  expect(PROTOCOL_VERSION).toBeGreaterThan(0);
});
