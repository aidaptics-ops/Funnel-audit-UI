import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeScreenshots } from "../src/lib/url";

const f = (name: string, size = 1000) => ({ name, size });

describe("mergeScreenshots", () => {
  it("orders by filename, not by the order they were picked", () => {
    // A file picker hands back directory order; a screenshot tool's timestamps
    // are what actually encode top-to-bottom.
    const picked = [f("shot 143229.png"), f("shot 143201.png"), f("shot 143215.png")];
    const { files } = mergeScreenshots([], picked, 4);
    assert.deepEqual(files.map((x) => x.name), [
      "shot 143201.png",
      "shot 143215.png",
      "shot 143229.png",
    ]);
  });

  it("collates numerically, so 2 comes before 10", () => {
    const { files } = mergeScreenshots([], [f("shot 10.png"), f("shot 2.png")], 4);
    assert.deepEqual(files.map((x) => x.name), ["shot 2.png", "shot 10.png"]);
  });

  it("accumulates across separate picks instead of replacing", () => {
    const first = mergeScreenshots([], [f("a.png")], 4);
    const second = mergeScreenshots(first.files, [f("b.png")], 4);
    assert.deepEqual(second.files.map((x) => x.name), ["a.png", "b.png"]);
  });

  it("ignores a file already in the list", () => {
    const { files, refused } = mergeScreenshots([f("a.png")], [f("a.png")], 4);
    assert.equal(files.length, 1);
    assert.equal(refused, 0, "a duplicate is not a refusal, it is a no-op");
  });

  it("refuses past the cap and reports how many did not fit", () => {
    const { files, refused } = mergeScreenshots(
      [f("a.png"), f("b.png"), f("c.png")],
      [f("d.png"), f("e.png"), f("g.png")],
      4,
    );
    assert.equal(files.length, 4);
    assert.equal(refused, 2);
  });

  it("refuses everything when the list is already full", () => {
    const full = [f("a.png"), f("b.png"), f("c.png"), f("d.png")];
    const { files, refused } = mergeScreenshots(full, [f("e.png")], 4);
    assert.equal(files.length, 4);
    assert.equal(refused, 1);
  });

  it("treats same name at a different size as a different file", () => {
    const { files } = mergeScreenshots([f("shot.png", 100)], [f("shot.png", 200)], 4);
    assert.equal(files.length, 2);
  });
});
