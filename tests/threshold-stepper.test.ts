import { describe, expect, it } from "vitest";
import { clampStepperValue, formatStepperDigits } from "../src/shared/threshold-stepper.js";

describe("threshold stepper", () => {
  it("clamps and snaps values to the configured step", () => {
    expect(clampStepperValue(90, 1, 100)).toBe(90);
    expect(clampStepperValue(0, 1, 100)).toBe(1);
    expect(clampStepperValue(140, 1, 100)).toBe(100);
    expect(clampStepperValue(83, 1, 200, 10)).toBe(80);
    expect(clampStepperValue(200, 1, 200)).toBe(200);
  });

  it("pads absolute digits and preserves a negative sign", () => {
    expect(formatStepperDigits(5)).toEqual({ negative: false, digits: ["0", "0", "5"] });
    expect(formatStepperDigits(90)).toEqual({ negative: false, digits: ["0", "9", "0"] });
    expect(formatStepperDigits(-12, 3)).toEqual({ negative: true, digits: ["0", "1", "2"] });
  });
});
