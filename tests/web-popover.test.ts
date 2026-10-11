import assert from "node:assert/strict";
import test from "node:test";
import { placePopover } from "../web/src/components/dismissible-popover.tsx";

test("popover aligns to the trigger end below when it fits", () => {
  assert.deepEqual(placePopover(
    { top: 20, right: 220, bottom: 60, left: 180, width: 40, height: 40 },
    { width: 120, height: 100 }, { width: 320, height: 240 }
  ), { top: 68, left: 100, placement: "bottom" });
});

test("popover flips above and stays inside viewport margins", () => {
  assert.deepEqual(placePopover(
    { top: 180, right: 310, bottom: 220, left: 270, width: 40, height: 40 },
    { width: 140, height: 120 }, { width: 320, height: 240 }
  ), { top: 52, left: 170, placement: "top" });
  assert.deepEqual(placePopover(
    { top: 2, right: 20, bottom: 22, left: 0, width: 20, height: 20 },
    { width: 400, height: 300 }, { width: 320, height: 240 }
  ), { top: 8, left: 8, placement: "bottom" });
});
