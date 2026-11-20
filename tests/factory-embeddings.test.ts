import { expect, it } from "vitest";
import { embedTexts } from "../src/factory/embeddings.js";

it("restores ordered 768-dimensional vectors using the upstream indices", async () => {
  const rows = Array.from({ length: 2 }, (_, index) => ({ index, embedding: Array.from({ length: 768 }, (_, j) => +(index === j)) }));
  const out = await embedTexts(["first", "second"], { apiKey: "test", fetchFn: async (url, req) => {
    expect(String(url)).toBe("https://api.sarvam.ai/v2/embeddings");
    expect(JSON.parse(String(req?.body))).toEqual({ model: "embeddinggemma-2", input: ["first", "second"], encoding_format: "float" });
    return Response.json({ model: "embeddinggemma-2", data: rows.toReversed(), usage: { prompt_tokens: 4, total_tokens: 4 } });
  }});
  expect(out.vectors.map(v => v.indexOf(1))).toEqual([0, 1]);
  expect(out.usage).toEqual({ promptTokens: 4, totalTokens: 4 });
});

it("rejects a partial or mismatched embedding batch", async () => {
  await expect(embedTexts(["first"], { apiKey: "test", fetchFn: async () =>
    Response.json({ model: "embeddinggemma-2", data: [{ index: 0, embedding: [0.1] }] }) })).rejects.toThrow(/vector/i);
});

it("rejects duplicate vector indexes and refuses over-limit requests before sending text", async () => {
  const row = {index:0,embedding:Array(768).fill(1)};
  await expect(embedTexts(["first","second"], {apiKey:"test", fetchFn:async () => Response.json({
    model:"embeddinggemma-2",data:[row,row],
  })})).rejects.toThrow(/index/i);
  await expect(embedTexts(Array(65).fill("sample"), {apiKey:"test",fetchFn:async () => {throw new Error("sent");}})).rejects.toThrow(/1–64/);
});
