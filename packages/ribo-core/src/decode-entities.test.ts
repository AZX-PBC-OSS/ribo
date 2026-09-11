import { expect, test } from "vitest";

import { decodeEntities } from "./decode-entities.js";

test("decodes the five named entities that appear in document text", () => {
  expect(decodeEntities("&amp;")).toBe("&");
  expect(decodeEntities("&lt;")).toBe("<");
  expect(decodeEntities("&gt;")).toBe(">");
  expect(decodeEntities("&quot;")).toBe('"');
  expect(decodeEntities("&apos;")).toBe("'");
});

test("decodes numeric character references (decimal and hex)", () => {
  expect(decodeEntities("&#39;")).toBe("'");
  expect(decodeEntities("&#x27;")).toBe("'");
  expect(decodeEntities("&#X27;")).toBe("'");
  expect(decodeEntities("&#8217;")).toBe("\u2019");
  expect(decodeEntities("&#x2019;")).toBe("\u2019");
});

test("leaves unknown entities unchanged", () => {
  expect(decodeEntities("&nosuch;")).toBe("&nosuch;");
  expect(decodeEntities("&")).toBe("&");
  expect(decodeEntities("plain text")).toBe("plain text");
});

test("decodes entities embedded in surrounding text", () => {
  expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
  expect(decodeEntities("a &amp; b &lt; c")).toBe("a & b < c");
  expect(decodeEntities("price &quot;$5,250.00&quot;")).toBe('price "$5,250.00"');
});

test("does not double-decode — a literal & is not touched", () => {
  expect(decodeEntities("Tom & Jerry")).toBe("Tom & Jerry");
  expect(decodeEntities("& &amp; &")).toBe("& & &");
});
