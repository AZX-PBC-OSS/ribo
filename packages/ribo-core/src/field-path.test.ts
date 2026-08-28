import { describe, expect, test } from "vitest";

import { buildFieldPath, childPath, parseFieldPath } from "./field-path.js";

describe("childPath", () => {
  test("joins a parent and an object key with a dot", () => {
    expect(childPath("hvac", "hvacDuctLeakage")).toBe("hvac.hvacDuctLeakage");
  });

  test("returns the key alone when the parent is empty", () => {
    expect(childPath("", "hvac")).toBe("hvac");
  });

  test("rejects an object key containing a dot", () => {
    expect(() => childPath("parent", "attic.rValue")).toThrow(/contains "\."/);
  });

  test("rejects an object key containing an open bracket", () => {
    expect(() => childPath("parent", "hvac[0]")).toThrow(/contains a bracket/);
  });

  test("rejects an integer-like object key", () => {
    expect(() => childPath("parent", "7")).toThrow(/is integer-like/);
  });
});

describe("buildFieldPath", () => {
  test("builds a path from object-key segments", () => {
    expect(
      buildFieldPath([
        { kind: "objectKey", key: "basedata" },
        { kind: "objectKey", key: "yearBuilt" },
      ]),
    ).toBe("basedata.yearBuilt");
  });

  test("builds a path with an instance-key segment", () => {
    expect(
      buildFieldPath([
        { kind: "objectKey", key: "hvac" },
        { kind: "instanceKey", key: "k3" },
        { kind: "objectKey", key: "hvacDuctLeakage" },
      ]),
    ).toBe("hvac[k3].hvacDuctLeakage");
  });

  test("rejects a leading instance-key segment", () => {
    expect(() =>
      buildFieldPath([
        { kind: "instanceKey", key: "k3" },
        { kind: "objectKey", key: "hvacDuctLeakage" },
      ]),
    ).toThrow(/must start with an object key/);
  });

  test("rejects an integer-like instance key", () => {
    expect(() =>
      buildFieldPath([
        { kind: "objectKey", key: "hvac" },
        { kind: "instanceKey", key: "0" },
        { kind: "objectKey", key: "hvacDuctLeakage" },
      ]),
    ).toThrow(/is integer-like/);
  });

  test("rejects a bracket character inside an instance key", () => {
    expect(() =>
      buildFieldPath([
        { kind: "objectKey", key: "hvac" },
        { kind: "instanceKey", key: "k[3" },
        { kind: "objectKey", key: "hvacDuctLeakage" },
      ]),
    ).toThrow(/contains "\["/);
  });
});

describe("parseFieldPath", () => {
  test("parses a dotted path into object-key segments", () => {
    expect(parseFieldPath("basedata.yearBuilt")).toEqual([
      { kind: "objectKey", key: "basedata" },
      { kind: "objectKey", key: "yearBuilt" },
    ]);
  });

  test("parses hvac[k3].hvacDuctLeakage into three segments", () => {
    expect(parseFieldPath("hvac[k3].hvacDuctLeakage")).toEqual([
      { kind: "objectKey", key: "hvac" },
      { kind: "instanceKey", key: "k3" },
      { kind: "objectKey", key: "hvacDuctLeakage" },
    ]);
  });

  test("rejects an unclosed instance key", () => {
    expect(() => parseFieldPath("hvac[k3.hvacDuctLeakage")).toThrow(/unclosed instance key/);
  });

  test("rejects an unexpected closing bracket", () => {
    expect(() => parseFieldPath("hvac]k3")).toThrow(/contains a bracket/);
  });
});

describe("round-trip", () => {
  test("build → parse → build yields the identical string", () => {
    const segments = [
      { kind: "objectKey", key: "hvac" },
      { kind: "instanceKey", key: "k3" },
      { kind: "objectKey", key: "hvacDuctLeakage" },
    ] as const;
    const built = buildFieldPath(segments);
    const parsed = parseFieldPath(built);
    const rebuilt = buildFieldPath(parsed);
    expect(rebuilt).toBe(built);
  });
});
