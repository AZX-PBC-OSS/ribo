// Probe 1: does the published ONNX export load outside a browser, and can we reproduce the
// wire format ourselves?
//
// This is the cheapest kill for the whole spike. `onnx-community/kev-0.6b-ONNX` puts the pointer
// head in the graph and documents the packing, but nothing in transformers.js knows what a kev is:
// the card's own snippet loads through the base `PreTrainedModel` because transformers.js resolves
// `qwen3` to a text-generation class expecting a KV-cache graph. If that path does not work in
// Node, no later probe is worth writing.
//
// Runs the model card's own three-question example verbatim, so a wrong answer here is OUR bug and
// not a model result. `q4` on CPU: `q4f16` keeps the graph in fp16 for WebGPU, which is not what
// onnxruntime-node wants.
import { AutoTokenizer, PreTrainedModel, Tensor } from "@huggingface/transformers";

const REPO = "onnx-community/kev-0.6b-ONNX";

const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(REPO);
const model = await PreTrainedModel.from_pretrained(REPO, { dtype: "q4", device: "cpu" });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Caller text can never produce a delimiter: <|name|> -> <¦name¦> (kev.user_text_escape).
const enc = (t) =>
  Array.from(
    tokenizer(t.replace(/<\|([A-Za-z0-9_]+)\|>/g, "<¦$1¦>"), { add_special_tokens: false })
      .input_ids.data,
    Number,
  );

// The delimiter ids come from `config.json`, NOT from encoding their names. The model card's
// snippet does the latter — and its own escape rewrites `<|fim_prefix|>` to `<¦fim_prefix¦>`
// before the lookup, so all five names tokenize as ordinary text and `enc(t)[0]` returns the id
// of `<` for every one of them. That failure is silent: the packing still runs and every question
// comes back exactly uniform (0.25/0.25/0.25/0.25), which is the model seeing no structure at all.
const ids = model.config.kev.delimiter_ids;
const [STATE, Q, OPT, END, DECIDE] = [
  ids.state,
  ids.question,
  ids.option_start,
  ids.option_end,
  ids.decide,
];
console.log("delimiters:", { STATE, Q, OPT, END, DECIDE });
if (new Set([STATE, Q, OPT, END, DECIDE]).size !== 5) throw new Error("delimiter ids collide");

const state =
  "I was charged twice for the same order and nobody answers my emails. I want my money back now.";
const questions = [
  {
    instr: "Which team should handle this ticket?",
    options: [
      "billing: Charges, refunds, invoices",
      "technical support: Bugs, outages, login problems",
      "sales",
      "account management",
    ],
  },
  { instr: "Is the customer asking for a refund?", options: ["no", "yes"] },
  {
    instr: "How positive is the sentiment of this message?",
    options: ["very negative", "negative", "neutral", "positive", "very positive"],
  },
];

const tokens = [STATE, ...enc(state)];
const groups = questions.map((q) => {
  const spans = q.options.map((o) => [OPT, ...enc(o), END]);
  const branch = [Q, ...enc(q.instr), ...spans.flat(), DECIDE];
  const base = tokens.length;
  let cursor = 1 + enc(q.instr).length;
  const ends = spans.map((s) => {
    cursor += s.length;
    return base + cursor - 1;
  }); // index of each </opt>
  tokens.push(...branch);
  return ends;
});
console.log(`packed ${tokens.length} tokens for ${questions.length} questions`);

// Assert the index arithmetic before trusting any probability: every recorded position must
// actually hold an END delimiter. An off-by-one here reads a neighbouring token's logit and still
// produces a plausible-looking distribution.
for (const ends of groups) {
  for (const i of ends) {
    if (tokens[i] !== END) throw new Error(`position ${i} is ${tokens[i]}, expected END ${END}`);
  }
}

const t1 = Date.now();
const { logits } = await model({
  input_ids: new Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length]),
  attention_mask: new Tensor("int64", new BigInt64Array(tokens.length).fill(1n), [
    1,
    tokens.length,
  ]),
});
console.log(`forward pass ${Date.now() - t1}ms, logits dims ${JSON.stringify(logits.dims)}`);

const scores = Array.from(logits.to("float32").data);
const softmax = (xs) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b);
  return e.map((x) => x / s);
};
const answers = groups.map((ends) => softmax(ends.map((i) => scores[i])));

for (const [i, q] of questions.entries()) {
  console.log(`\n${q.instr}`);
  for (const [j, o] of q.options.entries()) {
    console.log(`  ${answers[i][j].toFixed(4)}  ${o}`);
  }
}
